// VR（WebXR）と描画経路の確認ページ。dev/xr.html から読む（本番ビルドには含まれない）。
// WebGPURenderer を WebGL2 の経路（forceWebGL）で作り、天球に近い重さの場面（何層もの半透明の球殻と数千の星）を
// 動くゴンドラの上で描く。「VR で入る」で immersive-vr を始める。
//   ?iwer      IWER（Meta Quest 3 のエミュレーション）を読み込む。PC でも試せる
//   ?still     ゴンドラを止めておく（画面の撮影用）
//   ?stars=N   星の数（既定 4000）
//   ?shells=N  球殻の数（既定 8）
import * as THREE from 'three/webgpu';
import type { RideEvents } from '../../contracts/events';
import type { RidePose } from '../../contracts/ride';
import type { Touchable } from '../../contracts/room';
import { CAMERA } from '../../config';
import { createBus } from '../../core/events';
import { createXRSystem } from '../../xr';

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number) => {
  const v = Number(params.get(key));
  return Number.isFinite(v) && params.has(key) ? v : fallback;
};

interface Shared {
  xr: ReturnType<typeof createXRSystem>;
  frames: () => number;
  touches: () => { id: string; source: string }[];
  moving: boolean;
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGPURenderer;
  selected: string[];
  /** 触れられる物（id → 物体）。確認の自動操作が位置を読む */
  objects: Record<string, THREE.Object3D>;
}

async function main() {
  const panel = document.getElementById('panel');
  if (!panel) throw new Error('#panel がありません');
  const status = document.createElement('pre');
  status.id = 'status';
  const log: string[] = [];

  // IWER: 本物のブラウザの native の navigator.xr より優先して差し替える（forceInstall）
  if (params.has('iwer')) {
    const { XRDevice, metaQuest3 } = await import('iwer');
    const device = new XRDevice(metaQuest3);
    device.installRuntime({ forceInstall: true });
    (globalThis as unknown as { __iwerDevice?: unknown }).__iwerDevice = device;
    log.push('IWER（Meta Quest 3）を読み込みました');
  }

  const supported = (await navigator.xr?.isSessionSupported('immersive-vr').catch(() => false)) ?? false;
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true });
  await renderer.init();
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight, false);
  document.body.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b1c);
  const camera = new THREE.PerspectiveCamera(CAMERA.fovDeg, innerWidth / innerHeight, 0.05, 2000);

  // ── 重い場面: 何層もの半透明の球殻と、数千の星のインスタンス ──
  const rand = (() => {
    let s = 20261021;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  })();
  const shellCount = num('shells', 8);
  for (let i = 0; i < shellCount; i++) {
    const radius = 3 + i * 2.4;
    const hue = 0.58 + 0.04 * Math.sin(i);
    const mat = new THREE.MeshBasicNodeMaterial({
      color: new THREE.Color().setHSL(hue, 0.55, 0.55),
      transparent: true,
      opacity: 0.07,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
    shell.renderOrder = 10 + i;
    scene.add(shell);
  }
  const starCount = num('stars', 4000);
  const stars = new THREE.InstancedMesh(new THREE.SphereGeometry(0.06, 6, 4), new THREE.MeshBasicNodeMaterial({ color: 0xffffff }), starCount);
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  for (let i = 0; i < starCount; i++) {
    const r = 5 + rand() * 35;
    const u = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const k = Math.sqrt(1 - u * u);
    const s = 0.5 + rand() * 2.5;
    m.makeScale(s, s, s).setPosition(r * k * Math.cos(a), r * u, r * k * Math.sin(a));
    stars.setMatrixAt(i, m);
    stars.setColorAt(i, c.setHSL(0.1 + rand() * 0.15, 0.4, 0.75 + rand() * 0.2));
  }
  scene.add(stars);

  // ── ゴンドラ（簡易）: 座席の目の位置にカメラを置く。VR ではカメラが台へ移る ──
  const gondola = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.03, 8, 64), new THREE.MeshBasicNodeMaterial({ color: 0xb08d57 }));
  rim.rotation.x = Math.PI / 2;
  rim.position.y = -0.35;
  gondola.add(rim);
  const seat = new THREE.Object3D();
  seat.position.y = CAMERA.seatEyeHeight;
  gondola.add(seat);
  seat.add(camera);
  scene.add(gondola);

  // ── 触れられる物: 手の届く輪（ゴンドラの子）と、見つめて触れる遠くの物 ──
  const bus = createBus<RideEvents>();
  const touched: { id: string; source: string }[] = [];
  bus.on('touch', (e) => touched.push({ id: e.touchableId, source: e.source }));
  interface Item {
    readonly touchable: Touchable;
    readonly mesh: THREE.Mesh;
    readonly mat: THREE.MeshBasicNodeMaterial;
    readonly base: THREE.Color;
    level: number;
    pulse: number;
  }
  const items: Item[] = [];
  function addItem(id: string, parent: THREE.Object3D, x: number, y: number, z: number, radius: number, hue: number) {
    const mat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color().setHSL(hue, 0.6, 0.5) });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.8, 24, 16), mat);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    const item: Item = {
      mesh,
      mat,
      base: mat.color.clone(),
      level: 0,
      pulse: 0,
      touchable: {
        id,
        kind: 'star',
        section: 'celestial',
        object: mesh,
        radius,
        enabled: true,
        setHighlight: (level) => {
          item.level = level;
        },
        onTouch: () => {
          item.pulse = 1;
        },
      },
    };
    items.push(item);
  }
  // 台の周り 0.55m、胸の高さ（座席の目の高さの少し下）に 6 個
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    addItem(`near-${i}`, gondola, Math.sin(a) * 0.55, CAMERA.seatEyeHeight - 0.25, -Math.cos(a) * 0.55, 0.09, i / 6);
  }
  // 正面の遠くに 3 個（見つめて触れる）
  addItem('far-0', gondola, 0, 0.4, -4, 0.35, 0.05);
  addItem('far-1', gondola, -2, 0.6, -4, 0.35, 0.15);
  addItem('far-2', gondola, 2, 0.6, -4, 0.35, 0.3);

  const xr = createXRSystem(renderer, { scene, camera, events: bus, now: () => clock });
  xr.setTouchables(items.map((i) => i.touchable));
  xr.setVignette(0.5);
  const shared: Shared = {
    xr,
    frames: () => xrFrames,
    touches: () => touched,
    moving: !params.has('still'),
    scene,
    camera,
    renderer,
    selected: [],
    objects: Object.fromEntries(items.map((i) => [i.touchable.id, i.mesh])),
  };
  (globalThis as unknown as { __xrDev: Shared }).__xrDev = shared;

  // ── 画面 ──
  const button = (label: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', onClick);
    panel.append(b);
    return b;
  };
  const enterSeated = button('座って VR で入る', () => void start('seated'));
  const enterStanding = button('立って VR で入る', () => void start('standing'));
  enterSeated.disabled = enterStanding.disabled = !supported;
  button('正面を合わせ直す', () => xr.recenter());
  let menuOn = false;
  button('メニュー', () => {
    menuOn = !menuOn;
    if (!menuOn) {
      xr.hideMenu();
      return;
    }
    xr.showMenu(
      [
        { id: 'resume', label: '続ける' },
        { id: 'comfort', label: '快適モード' },
        { id: 'volume', label: '音量' },
        { id: 'alight', label: '降りる' },
      ],
      (id) => {
        shared.selected.push(id);
        log.push(`メニュー: ${id}`);
      },
    );
  });
  button('止まる / 動く', () => {
    shared.moving = !shared.moving;
  });
  button('VR を終える', () => void xr.exit());
  panel.append(status);

  async function start(posture: 'seated' | 'standing') {
    try {
      await xr.enter(posture);
      log.push(`VR を始めました（${posture}）`);
    } catch (err) {
      log.push(`VR を始められませんでした: ${String(err)}`);
      console.error(err);
    }
  }
  xr.onSessionEnd(() => log.push('VR が終わりました'));

  // ── 毎フレーム ──
  const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'celestial', sectionProgress: 0 };
  let clock = 0;
  let last = performance.now();
  let xrFrames = 0;
  let phi = 0;
  let fpsAcc = 0;
  let fpsFrames = 0;
  let fps = 0;
  let statusAcc = 0;
  const R = 8;
  const speed = 1.5;
  // ドラッグで見回す（画面のみ）
  let look = { yaw: 0, pitch: 0 };
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (e.buttons === 0 || xr.active) return;
    look = { yaw: look.yaw - e.movementX * 0.005, pitch: Math.max(-1, Math.min(1, look.pitch - e.movementY * 0.005)) };
  });

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const real = Math.min(0.1, (now - last) / 1000);
    last = now;
    const dt = shared.moving ? real : 0;
    clock += dt;
    phi += (dt * speed) / R;
    // 半径 R の円を一定の速さで回る（回転は speed/R = 約 10.7°/s で、上限 15°/s 以内）
    pose.x = R * Math.sin(phi);
    pose.z = R * (1 - Math.cos(phi));
    pose.yaw = Math.atan2(-Math.cos(phi), -Math.sin(phi));
    pose.speed = shared.moving ? speed : 0;
    gondola.position.set(pose.x, pose.y, pose.z);
    gondola.rotation.set(0, pose.yaw, 0);

    if (xr.active) {
      xr.update(clock, dt, pose);
      xrFrames++;
    } else {
      camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
    }

    for (const it of items) {
      it.pulse = Math.max(0, it.pulse - real * 2);
      it.mat.color.copy(it.base).lerp(c.setRGB(1, 0.95, 0.8), Math.max(it.level * 0.55, it.pulse));
      it.mesh.scale.setScalar(1 + 0.45 * it.pulse);
    }

    renderer.render(scene, camera);

    fpsAcc += real;
    fpsFrames++;
    if (fpsAcc >= 0.5) {
      fps = fpsFrames / fpsAcc;
      fpsAcc = 0;
      fpsFrames = 0;
    }
    statusAcc += real;
    if (statusAcc >= 0.25) {
      statusAcc = 0;
      const info = xr.debugInfo();
      const lines = [
        `WebGL2 forceWebGL  ${fps.toFixed(1)} fps  calls ${renderer.info.render.calls}  tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k`,
        `VR ${supported ? '対応' : '非対応'}  active ${info.active}  xrFrames ${xrFrames}  space ${info.referenceSpace}`,
        `頭 y=${info.headHeight.toFixed(2)} yaw=${info.headYawDeg.toFixed(0)}°  暗さ ${info.vignette.toFixed(2)}  触れた ${info.touches}`,
        ...log.slice(-4),
      ];
      status.textContent = lines.join('\n');
    }
  });

  addEventListener('resize', () => {
    if (xr.active) return;
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });
}

main().catch((err: unknown) => {
  console.error(err);
  const p = document.createElement('p');
  p.textContent = `起動できませんでした: ${String(err)}`;
  document.body.append(p);
});
