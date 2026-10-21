// rooms-c 確認ページ: 星の天球と夜明けの岸を、レールの上のゴンドラの目（座席の高さ）から描く。
// 時刻は ?t= から ?rate= の速さで進む（部屋は時刻から絵を決めるので、どの時刻からでも同じ絵になる）。
// 撮影用に window.__roomsC（準備ができたか、時刻、fps、描く回数）を出す。
import * as THREE from 'three/webgpu';
import { createAssetLoader } from '../../app/assets';
import { loadRideData } from '../../app/ride-data';
import { CAMERA } from '../../config';
import type { RideEvents } from '../../contracts/events';
import type { RoomContext, RoomFactory, RoomModule } from '../../contracts/room';
import type { RidePose } from '../../contracts/ride';
import { setDefaultGlassTier } from '../../core/materials/glass';
import { buildCueSheet, createRide, generateRideData } from '../../ride';
import { createCelestialRoom } from '../../rooms/celestial';
import { createDawnRoom } from '../../rooms/dawn';

type Tier = 'low' | 'medium' | 'high';
const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = Number(params.get(k));
  return params.has(k) && Number.isFinite(v) ? v : d;
};
const roomName = params.get('room') === 'dawn' ? 'dawn' : 'celestial';
const tierParam = params.get('tier');
const tier: Tier = tierParam === 'low' || tierParam === 'medium' ? tierParam : 'high';
const rate = num('rate', 1);
let t = num('t', roomName === 'dawn' ? 700 : 560);
const yawOff = (num('yaw', 0) * Math.PI) / 180;
const pitchOff = (num('pitch', 0) * Math.PI) / 180;
const hide = (params.get('hide') ?? '').split(',').filter(Boolean);
const reducedFlash = params.has('flash');
const touchN = num('touch', 0);
const hud = document.querySelector<HTMLDivElement>('#hud')!;
if (params.get('hud') === '0') hud.hidden = true;

const status = { ready: false, t, fps: 0, calls: 0, triangles: 0, backend: '', events: [] as string[] };
(globalThis as unknown as { __roomsC: typeof status }).__roomsC = status;

const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') });
await renderer.init();
status.backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.domElement.className = 'stage';
document.body.append(renderer.domElement);
setDefaultGlassTier(tier);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(num('fov', CAMERA.fovDeg), innerWidth / innerHeight, 0.05, 2000);
camera.rotation.order = 'YXZ';

const data = (await loadRideData()) ?? generateRideData();
const ride = createRide(data);
const cues = buildCueSheet();
const PARTICLES: Record<Tier, number> = { high: 1, medium: 0.7, low: 0.4 };
const factory: RoomFactory = roomName === 'dawn' ? createDawnRoom : createCelestialRoom;
const room: RoomModule = factory();
await room.load({
  ride,
  assets: createAssetLoader(),
  events: {
    on: () => () => {},
    emit<K extends keyof RideEvents>(type: K, payload: RideEvents[K]) {
      status.events.push(`${String(type)} ${JSON.stringify(payload)}`);
    },
  },
  // 部屋が読むのは tier と particleScale だけ（品質の型は core の側で変わりうるので、ここでは形だけ合わせる）
  quality: {
    tier,
    maxPixelRatio: 2,
    renderScale: 1,
    minRenderScale: 0.6,
    targetFps: 60,
    postFx: tier !== 'low',
    particleScale: PARTICLES[tier],
    envMapSize: 256,
    antialias: true,
  } as unknown as RoomContext['quality'],
  comfort: () => 'standard',
  reducedFlash: () => reducedFlash,
  suggestedDoor: null,
  hiddenAlreadyFound: false,
});
scene.add(room.root);
room.root.traverse((o) => {
  const name = typeof o.userData.name === 'string' ? o.userData.name : o.name;
  if (hide.some((h) => o.userData.role === h || name.includes(h))) o.visible = false;
});

const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 };
let atmosphere: RoomModule['atmosphere'] | null = null;
let cueIndex = cues.findIndex((c) => c.t >= t);
if (cueIndex < 0) cueIndex = cues.length;

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let last = performance.now();
let frames = 0;
let fpsAt = last;
let touched = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000) * rate;
  last = now;
  t += dt;
  while (cueIndex < cues.length && cues[cueIndex].t <= t) room.onCue(cues[cueIndex++]);
  ride.poseAt(t, 'standard', pose);
  camera.position.set(pose.x, pose.y + CAMERA.seatEyeHeight, pose.z);
  camera.rotation.set(pitchOff, pose.yaw + yawOff, 0);
  camera.updateMatrixWorld(true);
  room.update({ t, dt, pose, camera, comfort: 'standard', reducedFlash });
  if (touched < touchN && room.touchables.length > 0) {
    // 確かめるために触れる（近い物から）
    const list = [...room.touchables].sort((a, b) => a.object.getWorldPosition(new THREE.Vector3()).distanceTo(camera.position) - b.object.getWorldPosition(new THREE.Vector3()).distanceTo(camera.position));
    const target = list[touched % list.length];
    const p = target.object.getWorldPosition(new THREE.Vector3());
    target.onTouch({ t, source: 'pointer', point: [p.x, p.y, p.z] });
    touched++;
  }
  if (room.atmosphere !== atmosphere) {
    atmosphere = room.atmosphere;
    scene.background = new THREE.Color(atmosphere.background);
    scene.fog = atmosphere.fog ? new THREE.Fog(atmosphere.fog.color, atmosphere.fog.near, atmosphere.fog.far) : null;
    renderer.toneMappingExposure = atmosphere.exposure;
  }
  renderer.render(scene, camera);
  frames++;
  if (now - fpsAt > 500) {
    status.fps = (frames * 1000) / (now - fpsAt);
    frames = 0;
    fpsAt = now;
  }
  status.t = t;
  status.calls = renderer.info.render.drawCalls;
  status.triangles = renderer.info.render.triangles;
  status.ready = true;
  const m = Math.floor(t / 60);
  hud.textContent = `${status.backend} ${tier}  ${status.fps.toFixed(0)}fps  calls ${status.calls}  tris ${Math.round(status.triangles / 1000)}k\n${roomName}  t=${t.toFixed(2)} (${m}:${(t - m * 60).toFixed(1).padStart(4, '0')})  ${pose.section}`;
});
