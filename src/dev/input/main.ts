// 見回すと触れるの確認ページ（dev/input.html）。本番ビルドには含まれない。
// ガラス玉を並べ、ドラッグ・追従・クリック・見つめる・近づく（縁の光と自分で鳴る合図）を目で確かめる。
//   ?mode=follow   追従モードで始める       ?dwell=0.8      見つめる秒（0.8 / 1.2 / 2.0）
//   ?gyro          端末の傾きで見回す       ?move=0         ゴンドラを止める
//   ?t=20          乗車の 20 秒の位置から   ?webgl         WebGL2 で描く
//   ?fov=90        視野角（60〜90）。ドラッグの感度がこれに合う
import * as THREE from 'three/webgpu';
import { dot, float, normalView, positionViewDirection, pow, saturate, uniform } from 'three/tsl';
import { CAMERA, INTERACTION } from '../../config';
import type { RideEvents } from '../../contracts/events';
import type { SectionId, TouchKind } from '../../contracts/ids';
import type { Touchable } from '../../contracts/room';
import { createBus } from '../../core/events';
import { num, oneOf } from '../../core/storage';
import { createLookControl, createTouchInput } from '../../input';

const DEG = Math.PI / 180;
/** 回廊の長さ（m）と、ゴンドラの速さ（m/s）。端まで行ったら乗車の秒を 0 に戻す（巻き戻しの確認も兼ねる） */
const CORRIDOR_LENGTH = 80;
const SPEED = 1.6;
const EYE_HEIGHT = CAMERA.seatEyeHeight;
const PULSE_SEC = 0.9;

// ── URL パラメータ（外から来る値なので検証して読む） ──
const q = new URLSearchParams(location.search);
const startMode = oneOf(q.get('mode'), ['drag', 'follow'] as const, 'drag');
const startDwell = oneOf(Number(q.get('dwell')), INTERACTION.gazeDwellChoices, INTERACTION.gazeDwellSec);
const startGyro = q.has('gyro') && q.get('gyro') !== '0';
const startMove = q.get('move') !== '0';
const startFov = num(Number(q.get('fov')), CAMERA.fovDeg, CAMERA.fovMinDeg, CAMERA.fovMaxDeg);
const startT = num(Number(q.get('t')), 0, 0, CORRIDOR_LENGTH / SPEED);

// ── 描画 ──
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: q.has('webgl') });
await renderer.init();
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
const canvas = renderer.domElement;
document.body.prepend(canvas);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b2230);
scene.fog = new THREE.Fog(0x1b2230, 30, 90);
const camera = new THREE.PerspectiveCamera(startFov, innerWidth / innerHeight, 0.05, 200);
const grid = new THREE.GridHelper(160, 80, 0x4a5a78, 0x2c3850);
grid.position.y = -2.2;
scene.add(grid);

// ── ガラス玉（縁の光と触れたときの光を、描画の側で持つ） ──
interface Ball {
  readonly touchable: Touchable & { highlight: number; touchCount: number };
  readonly mesh: THREE.Mesh;
  readonly uHighlight: { value: number };
  readonly uPulse: { value: number };
  readonly baseScale: number;
  pulse: number;
}
const balls: Ball[] = [];
const decoys: THREE.Mesh[] = [];
const sphereGeo = new THREE.SphereGeometry(1, 40, 24);

function makeMaterial(color: number, dim: boolean) {
  const uHighlight = uniform(0);
  const uPulse = uniform(0);
  const tint = uniform(new THREE.Color(color));
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  // 縁（視線に対して浅い所）ほど明るい。触れられる物に近づくと縁が強まり、触れると全体が一瞬明るく濃くなる
  const rim = pow(float(1).sub(saturate(dot(normalView, positionViewDirection))), 2.2);
  const base = dim ? 0.05 : 0.16;
  material.colorNode = tint.mul(float(0.55).add(rim.mul(uHighlight.mul(1.6).add(0.35))).add(uPulse.mul(0.9)));
  material.opacityNode = saturate(float(base).add(rim.mul(float(dim ? 0.12 : 0.45).add(uHighlight.mul(0.4)))).add(uPulse.mul(0.4)));
  return { material, uHighlight, uPulse };
}

interface BallSpec {
  readonly id: string;
  readonly kind: TouchKind;
  readonly section: SectionId;
  readonly pos: readonly [number, number, number];
  readonly radius: number;
  readonly color: number;
  readonly idleChime: boolean;
  readonly enabled: boolean;
}

function addBall(spec: BallSpec) {
  const { material, uHighlight, uPulse } = makeMaterial(spec.enabled ? spec.color : 0x8a93a3, !spec.enabled);
  const mesh = new THREE.Mesh(sphereGeo, material);
  mesh.position.set(...spec.pos);
  mesh.scale.setScalar(spec.radius);
  scene.add(mesh);
  const ball: Ball = {
    mesh,
    uHighlight,
    uPulse,
    baseScale: spec.radius,
    pulse: 0,
    touchable: {
      id: spec.id,
      kind: spec.kind,
      section: spec.section,
      object: mesh,
      radius: spec.radius,
      enabled: spec.enabled,
      idleChime: spec.idleChime,
      highlight: 0,
      touchCount: 0,
      setHighlight(level) {
        ball.touchable.highlight = level;
        uHighlight.value = level;
      },
      onTouch() {
        // 同じ出来事の中で光と大きさを変える（0.1 秒以内の応え）
        ball.touchable.touchCount++;
        ball.pulse = 1;
        uPulse.value = 1;
        mesh.scale.setScalar(ball.baseScale * 1.45);
      },
    },
  };
  balls.push(ball);
}

/** ゴンドラの正面から yaw（左が正）・pitch（上が正）の方向、距離 r の点 */
function around(yawDeg: number, pitchDeg: number, r: number): [number, number, number] {
  const y = yawDeg * DEG;
  const p = pitchDeg * DEG;
  return [-r * Math.cos(p) * Math.sin(y), EYE_HEIGHT + r * Math.sin(p), -r * Math.cos(p) * Math.cos(y)];
}

// 出発地点のまわりの輪: 見回しの範囲（左右 ±120°、上下 ±60°）の端まで見に行ける
const ring: [string, number, number, number][] = [
  ['front', 0, 0, 0xffd89a],
  ['L40', 40, 0, 0x9ad8ff],
  ['R40', -40, 0, 0xff9ac8],
  ['L80', 80, 0, 0xb8ff9a],
  ['R80', -80, 0, 0xd09aff],
  ['L120', 120, 0, 0xffb38a],
  ['R120', -120, 0, 0x8affd9],
  ['up45', 0, 45, 0xfff29a],
  ['down45', 0, -40, 0x9ab4ff],
];
for (const [name, yaw, pitch, color] of ring) {
  addBall({ id: `ring/${name}`, kind: 'hanging-bubble', section: 'platform', pos: around(yaw, pitch, 4.5), radius: 0.5, color, idleChime: false, enabled: true });
}
// 遠くの物（22m）。見つめて触れる距離（物の表面まで gazeMaxDistance）には入るが、縁は光らない
addBall({ id: 'far/22', kind: 'bud', section: 'platform', pos: around(25, 12, 22), radius: 1.2, color: 0xffd0a0, idleChime: false, enabled: true });
// 回廊: ゴンドラが進むと順に近づく（縁の光 → 自分で鳴る合図）。奇数番は idleChime なし
const palette = [0xffd89a, 0x9ad8ff, 0xff9ac8, 0xb8ff9a, 0xd09aff, 0xffb38a, 0x8affd9, 0xfff29a, 0x9ab4ff, 0xffa0a0];
for (let i = 0; i < 10; i++) {
  addBall({
    id: `corridor/${i}`,
    kind: i % 3 === 0 ? 'leaf' : i % 3 === 1 ? 'raindrop' : 'bud',
    section: 'greenhouse',
    pos: [(i % 2 ? 1 : -1) * (1.6 + 0.4 * (i % 3)), EYE_HEIGHT + (((i * 37) % 5) - 2) * 0.35, -10 - i * 7],
    radius: 0.45 + 0.1 * (i % 3),
    color: palette[i],
    idleChime: i % 2 === 0,
    enabled: true,
  });
}
// まだ現れていない物（enabled=false）。光らず、触れても反応しない
for (const [i, z] of [-16, -44].entries()) {
  addBall({ id: `disabled/${i}`, kind: 'door', section: 'rain', pos: [0, EYE_HEIGHT, z], radius: 0.7, color: 0x8a93a3, idleChime: true, enabled: false });
}
// 触れられない飾り（クリックしても何も起きない）
for (let i = 0; i < 6; i++) {
  const m = new THREE.Mesh(sphereGeo, makeMaterial(0x6b7894, true).material);
  m.scale.setScalar(0.3);
  m.position.set(i % 2 ? 3.2 : -3.4, EYE_HEIGHT - 0.8 + (i % 3) * 0.5, -6 - i * 12);
  scene.add(m);
  decoys.push(m);
}
scene.updateMatrixWorld(true); // 最初の update の前に、物の位置を matrixWorld に反映しておく

// ── 入力 ──
const bus = createBus<RideEvents>();
/** 乗車の秒。ゴンドラを止めても進み続ける（時計は止まらない）。端まで行くか「最初から」で 0 に戻る */
let rideT = startT;
/** ゴンドラが進んだ距離（m） */
let travel = startT * SPEED;
const deps = { element: canvas, events: bus, now: () => rideT };
const look = createLookControl(deps, { mode: startMode, gyro: false, fovDeg: startFov });
const touch = createTouchInput(deps);
touch.setGazeDwell(startDwell);
look.setEnabled(true);
touch.setEnabled(true);

interface TouchLog {
  readonly id: string;
  readonly source: string;
  readonly t: number;
  readonly wall: number;
}
const touchLog: TouchLog[] = [];
const chimeLog: string[] = [];
const textLog: string[] = [];
const pushLog = (line: string) => {
  textLog.unshift(line);
  textLog.length = Math.min(textLog.length, 6);
};
bus.on('touch', (e) => {
  touchLog.push({ id: e.touchableId, source: e.source, t: e.t, wall: performance.now() });
  pushLog(`触れた ${e.touchableId} [${e.source}] t=${e.t.toFixed(2)}`);
});
touch.onIdleChime((t) => {
  chimeLog.push(t.id);
  const ball = balls.find((b) => b.touchable === t);
  if (ball) {
    // 自分で鳴る合図は控えめな光（触れたときの半分）
    ball.pulse = Math.max(ball.pulse, 0.5);
    ball.uPulse.value = ball.pulse;
  }
  pushLog(`自分で鳴る ${t.id}`);
});
touch.setTouchables(balls.map((b) => b.touchable));

// ── 操作パネル ──
const panelOrNull = document.getElementById('panel');
if (!panelOrNull) throw new Error('#panel がありません');
const panel: HTMLElement = panelOrNull;
const status = document.createElement('pre');
status.id = 'status';
let moving = startMove;

function addSelect<T extends string>(label: string, id: string, options: readonly (readonly [T, string])[], value: T, onChange: (v: T) => void) {
  const wrap = document.createElement('label');
  wrap.append(label);
  const sel = document.createElement('select');
  sel.id = id;
  for (const [v, text] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = text;
    sel.append(o);
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value as T));
  wrap.append(sel);
  panel.append(wrap);
}
function addCheck(label: string, id: string, value: boolean, onChange: (v: boolean) => void) {
  const wrap = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = id;
  box.checked = value;
  box.addEventListener('change', () => onChange(box.checked));
  wrap.append(box, label);
  panel.append(wrap);
  return box;
}
function addButton(label: string, id: string, onClick: () => void) {
  const b = document.createElement('button');
  b.id = id;
  b.textContent = label;
  b.addEventListener('click', onClick);
  panel.append(b, ' ');
}

let mode = startMode;
let gyro = false;
let fov: number = startFov;
const applyLook = () => look.setOptions({ mode, gyro, fovDeg: fov });
addSelect('見回し', 'mode', [['drag', 'ドラッグ'], ['follow', 'マウスに追従']] as const, startMode, (v) => {
  mode = v;
  applyLook();
});
addSelect('視野角', 'fov', [['60', '60°'], ['75', '75°'], ['90', '90°']] as const, String(startFov), (v) => {
  fov = Number(v);
  camera.fov = fov;
  camera.updateProjectionMatrix();
  applyLook();
});
addSelect('見つめる', 'dwell', INTERACTION.gazeDwellChoices.map((s) => [String(s), `${s} 秒`] as const), String(startDwell), (v) => touch.setGazeDwell(Number(v)));
panel.append(document.createElement('br'));
const gyroBox = addCheck('端末の傾き', 'gyro', false, (on) => {
  void (async () => {
    if (on) {
      // iOS は操作をきっかけに許可を求める必要がある
      const Dev = globalThis.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> };
      if (typeof Dev?.requestPermission === 'function') {
        try {
          if ((await Dev.requestPermission()) !== 'granted') on = false;
        } catch {
          on = false;
        }
      }
    }
    gyro = on;
    gyroBox.checked = on;
    applyLook();
  })();
});
addCheck('ゴンドラが進む', 'move', startMove, (v) => (moving = v));
addCheck('見回し有効', 'lookOn', true, (v) => look.setEnabled(v));
addCheck('触れる有効', 'touchOn', true, (v) => touch.setEnabled(v));
panel.append(document.createElement('br'));
addButton('正面へ戻す', 'recenter', () => look.recenter(undefined, CAMERA.recenterSec));
addButton('右上へ向ける', 'recenterRight', () => look.recenter({ yaw: -30 * DEG, pitch: 15 * DEG }, 1));
addButton('最初から', 'restart', () => {
  rideT = 0;
  travel = 0;
});
panel.append(status);
if (startGyro) {
  gyro = true;
  gyroBox.checked = true;
  applyLook();
}

// ── 確認用の窓口（Playwright から使う） ──
const projected = new THREE.Vector3();
const ballOf = (id: string) => balls.find((b) => b.touchable.id === id);
/** 毎フレームの向きの記録（急な振れの確認用。dt はそのフレームで look.update に渡した秒） */
const traceLog: { dt: number; yaw: number; pitch: number }[] = [];
let tracing = false;
const hook = {
  ready: true,
  /** 記録を始める（毎フレームの yaw・pitch・dt） */
  traceStart() {
    traceLog.length = 0;
    tracing = true;
  },
  /** 記録を止めて、フレームごとの向きの変化の最大（度）と、角速度の最大（度/秒）を返す */
  traceStop() {
    tracing = false;
    let maxStepYaw = 0;
    let maxStepPitch = 0;
    let maxSpeed = 0;
    for (let i = 1; i < traceLog.length; i++) {
      const dy = Math.abs(traceLog[i].yaw - traceLog[i - 1].yaw) / DEG;
      const dp = Math.abs(traceLog[i].pitch - traceLog[i - 1].pitch) / DEG;
      maxStepYaw = Math.max(maxStepYaw, dy);
      maxStepPitch = Math.max(maxStepPitch, dp);
      if (traceLog[i].dt > 0) maxSpeed = Math.max(maxSpeed, Math.hypot(dy, dp) / traceLog[i].dt);
    }
    return { frames: traceLog.length, maxStepYaw, maxStepPitch, maxSpeed };
  },
  backend,
  look: look.look,
  touchLog,
  chimeLog,
  /** 物の中心の、canvas 内の位置（CSS px）。画面の外・後ろなら null */
  screenOf(id: string): { x: number; y: number } | null {
    const b = ballOf(id);
    if (!b) return null;
    camera.updateMatrixWorld();
    b.mesh.getWorldPosition(projected).project(camera);
    if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) return null;
    return { x: ((projected.x + 1) / 2) * innerWidth, y: ((1 - projected.y) / 2) * innerHeight };
  },
  /** その物が画面の中央に来る向きへ、すぐに向ける */
  aim(id: string) {
    const b = ballOf(id);
    if (!b) return;
    const d = b.mesh.position.clone().sub(camera.position);
    look.recenter({ yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) }, 0);
  },
  /** ゴンドラを回廊の d メートルの所へ置く（時計はそのまま） */
  setTravel(d: number) {
    travel = d;
  },
  /** 乗車の秒を 0 に戻して最初へ（新しい乗車の始まり） */
  rewind() {
    rideT = 0;
    travel = 0;
  },
  setMoving(v: boolean) {
    moving = v;
  },
  highlights(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const b of balls) out[b.touchable.id] = b.touchable.highlight;
    return out;
  },
  scales(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const b of balls) out[b.touchable.id] = b.mesh.scale.x / b.baseScale;
    return out;
  },
  /** dev ページの状態の要約（検証用） */
  gondolaZ: () => camera.position.z,
};
(globalThis as unknown as { __inputDev: typeof hook }).__inputDev = hook;

// ── 毎フレーム ──
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

let last = performance.now();
let statusAt = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  rideT += dt;
  if (moving) travel += dt * SPEED;
  if (travel > CORRIDOR_LENGTH) {
    rideT = 0; // 端まで行ったら最初へ（乗車の秒が戻る）
    travel = 0;
  }
  const z = -travel;
  camera.position.set(0, EYE_HEIGHT, z);
  look.update(dt);
  if (tracing) traceLog.push({ dt, yaw: look.look.yaw, pitch: look.look.pitch });
  camera.rotation.set(look.look.pitch, look.look.yaw, 0, 'YXZ');
  camera.updateMatrixWorld();
  touch.update(rideT, dt, camera, [0, 0, z]);

  // 触れた反応: 大きくなって、すぐ戻る
  for (const b of balls) {
    if (b.pulse > 0) {
      b.pulse = Math.max(0, b.pulse - dt / PULSE_SEC);
      b.uPulse.value = b.pulse * b.pulse;
      const grow = b.pulse * b.pulse * b.pulse;
      b.mesh.scale.setScalar(b.baseScale * (1 + 0.45 * grow));
    }
  }

  renderer.render(scene, camera);

  if (now - statusAt > 100) {
    statusAt = now;
    const lit = balls
      .filter((b) => b.touchable.highlight > 0)
      .sort((a, b) => b.touchable.highlight - a.touchable.highlight)
      .slice(0, 3)
      .map((b) => `${b.touchable.id} ${b.touchable.highlight.toFixed(2)}`);
    status.textContent = [
      `${backend}  yaw ${(look.look.yaw / DEG).toFixed(1)}°  pitch ${(look.look.pitch / DEG).toFixed(1)}°  (±${CAMERA.yawRangeDeg}° / ±${CAMERA.pitchRangeDeg}°)`,
      `ゴンドラ z=${z.toFixed(1)}m  t=${rideT.toFixed(1)}s`,
      `触れた ${touchLog.length}  自分で鳴る ${chimeLog.length}`,
      `縁が光る: ${lit.join(', ') || 'なし'}`,
      ...textLog,
    ].join('\n');
  }
});
