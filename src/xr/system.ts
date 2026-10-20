// VR（WebXR）の本体。three/webgpu の WebGPURenderer を WebGL2 の経路（forceWebGL）で使い、
// immersive-vr のセッションを renderer.xr（XRManager）に渡して描く。
//
// 方針（設計書「ライドとカメラ › カメラ（VR）」）:
//  - カメラを演出で動かさない。台（rig）をゴンドラの座席に置き、カメラは台の子として頭の動きだけを受ける。
//  - 座る / 立つで基準空間（local / local-floor）を変え、最初の数フレームで頭の高さと向きを測って台の高さと向きを合わせる。
//  - 触れるのは指先（コントローラーの先・手の人差し指の先）と、トリガーで指す・見つめる（INT-2）の3通り。
//  - 毎フレームの確保を避ける。作業用のベクトルは使い回す。後処理は使わない。
import * as THREE from 'three/webgpu';
import type { Vec3Tuple } from '../contracts/events';
import type { TouchSource, XRPosture } from '../contracts/ids';
import type { RidePose } from '../contracts/ride';
import type { Touchable } from '../contracts/room';
import type { XRDeps, XRSystem } from '../contracts/xr';
import { INTERACTION, XR } from '../config';
import { damp, smoothstep, wrapAngle } from '../core/easing';
import {
  menuPose,
  nearestTouchable,
  rayTouchable,
  recenterYaw,
  referenceSpaceFor,
  rigHeightOffset,
  vignetteFor,
  yawFromQuaternion,
  type Nearest,
  type RayHit,
} from './logic';
import { createMenu, type MenuItem, type MenuPanel } from './menu';
import { XR_TUNING } from './tuning';
import { createVignette, type Vignette } from './vignette';

/** 契約（XRSystem）に足す、統合担当向けの口 */
export interface XRSystemExtras {
  /** 見つめて触れるまでの秒（設定の 0.8 / 1.2 / 2.0）。既定は INTERACTION.gazeDwellSec */
  setGazeDwell(sec: number): void;
  /** 確認ページと e2e が読む内部の状態 */
  debugInfo(): XRDebugInfo;
}

export interface XRDebugInfo {
  readonly active: boolean;
  readonly referenceSpace: string;
  readonly calibrated: boolean;
  readonly headHeight: number;
  readonly headYawDeg: number;
  readonly vignette: number;
  readonly menuOpen: boolean;
  readonly sources: readonly { readonly hand: boolean; readonly mode: string }[];
  readonly touches: number;
}

/**
 * three r186 の WebGL バックエンド（WebGLState.drawBuffers）は、描画先の framebuffer を WeakMap の鍵にするため、
 * null（既定のフレームバッファ）が来ると「Invalid value used as weak map key」で毎フレーム落ちる。
 * 実機のブラウザの XRWebGLLayer / 投影レイヤーは null でない framebuffer やテクスチャを返すので起きないが、
 * IWER（エミュレーション）の XRWebGLLayer.framebuffer は null を返す。e2e で試せるよう、鍵が null の分だけ別に持つ WeakMap に差し替える。
 */
class NullKeyWeakMap<V extends object> extends WeakMap<WeakKey, V> {
  private nullValue: V | undefined;
  override get(key: WeakKey | null): V | undefined {
    return key === null ? this.nullValue : super.get(key);
  }
  override set(key: WeakKey | null, value: V): this {
    if (key === null) this.nullValue = value;
    else super.set(key, value);
    return this;
  }
}

function tolerateNullFramebuffer(renderer: THREE.WebGPURenderer) {
  const state = (renderer as unknown as { backend?: { isWebGLBackend?: boolean; state?: { currentDrawbuffers?: unknown } } }).backend?.state;
  if (state?.currentDrawbuffers instanceof WeakMap && !(state.currentDrawbuffers instanceof NullKeyWeakMap)) {
    state.currentDrawbuffers = new NullKeyWeakMap();
  }
}

const SLOT_COUNT = 2;
const RAD2DEG = 180 / Math.PI;

interface Slot {
  readonly ray: THREE.Group;
  readonly hand: THREE.Group & { joints: Record<string, THREE.Group> };
  readonly tip: THREE.Mesh;
  source: XRInputSource | null;
  /** 指先がいま触れている物（離れるまで繰り返さない） */
  held: Touchable | null;
  /** 指先が押し込んでいるメニューの項目（-1: なし） */
  pokeItem: number;
  /** この更新で指先が取れたか。取れたときのワールド座標 */
  valid: boolean;
  x: number;
  y: number;
  z: number;
}

type CtrlEvents = {
  connected: { data: XRInputSource };
  disconnected: { data: XRInputSource };
  selectstart: { data: XRInputSource };
};

export function createXRSystem(renderer: THREE.WebGPURenderer, deps: XRDeps): XRSystem & XRSystemExtras {
  const rig = new THREE.Group();
  rig.name = 'xr-rig';

  // ── セッションと台 ──
  let session: XRSession | null = null;
  /** setSession が終わり、次のフレームから XR で描ける。それまでは active にしない（enter の完了と同時に true になる） */
  let ready = false;
  let posture: XRPosture = 'seated';
  let refSpace: 'local' | 'local-floor' = 'local';
  const endListeners: (() => void)[] = [];
  let camParent: THREE.Object3D | null = null;
  const camSaved = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) };

  // 正面の合わせ（基準空間での、合わせた時点の頭の位置と向き）
  let needsCalibrate = false;
  let calibrated = false;
  let headX = 0;
  let headY = 0;
  let headZ = 0;
  let headYaw = 0;
  let recenterOffset = 0;
  let watchedSpace: XRReferenceSpace | null = null;
  let frames = 0;

  // ── 時間 ──
  let lastMs = 0;
  let lastT = 0;
  let lastYaw = 0;
  let haveLastYaw = false;

  // ── 外周の暗さ ──
  let vignetteSetting: number = XR.vignetteDefault;
  let vignetteNow = 0;
  let vignette: Vignette | null = null;

  // ── 触れる ──
  let touchables: readonly Touchable[] = [];
  let levels = new Float32Array(0);
  let gazeDwell: number = INTERACTION.gazeDwellSec;
  let gazeIndex = -1;
  let gazeTime = 0;
  let gazeFired = false;
  let touchCount = 0;
  const near: Nearest = { index: -1, distance: Infinity };
  const rayHit: RayHit = { index: -1, along: Infinity };

  // ── コントローラーと手 ──
  const slots: Slot[] = [];
  let controllersReady = false;
  let tipGeometry: THREE.SphereGeometry | null = null;
  let tipMaterial: THREE.MeshBasicNodeMaterial | null = null;

  // ── メニュー ──
  let menu: MenuPanel | null = null;
  let menuItems: readonly MenuItem[] = [];
  let menuCallback: ((id: string) => void) | null = null;
  let menuOpen = false;
  let menuPending = false;
  let menuGazeIndex = -1;
  let menuGazeTime = 0;
  let menuGazeFired = false;

  // 作業用（毎フレームの確保を避ける）
  const _v = new THREE.Vector3();
  const _o = new THREE.Vector3();
  const _d = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _inv = new THREE.Matrix4();
  const _head = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: -1 };

  // ───────────────────────────── 準備と後片付け ─────────────────────────────

  function ensureControllers() {
    if (controllersReady) return;
    controllersReady = true;
    tipGeometry = new THREE.SphereGeometry(XR_TUNING.tipRadius, 10, 8);
    tipMaterial = new THREE.MeshBasicNodeMaterial({ color: 0xffe6b0, fog: false, toneMapped: false });
    for (let i = 0; i < SLOT_COUNT; i++) {
      const ray = renderer.xr.getController(i);
      const grip = renderer.xr.getControllerGrip(i);
      const hand = renderer.xr.getHand(i) as unknown as Slot['hand'];
      // 台の子にして、台がゴンドラと一緒に動くと手もついてくる（基準空間の座標は台の局所座標になる）
      rig.add(ray, grip, hand);
      const tip = new THREE.Mesh(tipGeometry, tipMaterial);
      tip.name = `xr-tip-${i}`;
      tip.visible = false;
      tip.frustumCulled = false;
      rig.add(tip);
      const slot: Slot = { ray, hand, tip, source: null, held: null, pokeItem: -1, valid: false, x: 0, y: 0, z: 0 };
      slots.push(slot);
      const dispatcher = ray as unknown as THREE.EventDispatcher<CtrlEvents>;
      dispatcher.addEventListener('connected', (e) => {
        slot.source = e.data;
      });
      dispatcher.addEventListener('disconnected', () => {
        slot.source = null;
        slot.held = null;
        slot.valid = false;
        slot.tip.visible = false;
      });
      dispatcher.addEventListener('selectstart', () => onSelectStart(slot));
    }
  }

  function attach(s: XRSession) {
    session = s;
    ready = false;
    const cam = deps.camera;
    camParent = cam.parent;
    camSaved.position.copy(cam.position);
    camSaved.quaternion.copy(cam.quaternion);
    camSaved.scale.copy(cam.scale);
    // カメラを台の子にする。向きと位置は XRManager が毎フレーム頭の姿勢で上書きする
    rig.add(cam);
    cam.position.set(0, 0, 0);
    cam.quaternion.identity();
    cam.scale.set(1, 1, 1);
    deps.scene.add(rig);
    ensureControllers();
    if (!vignette) vignette = createVignette();
    cam.add(vignette.mesh);
    vignette.set(0);
    needsCalibrate = true;
    calibrated = false;
    frames = 0;
    haveLastYaw = false;
    vignetteNow = 0;
    lastMs = performance.now();
    renderer.xr.addEventListener('sessionend', onSessionEnd);
  }

  function detach() {
    const cam = deps.camera;
    cam.removeFromParent();
    if (camParent) camParent.add(cam);
    cam.position.copy(camSaved.position);
    cam.quaternion.copy(camSaved.quaternion);
    cam.scale.copy(camSaved.scale);
    camParent = null;
    vignette?.mesh.removeFromParent();
    vignette?.set(0);
    deps.scene.remove(rig);
    for (const slot of slots) {
      slot.held = null;
      slot.valid = false;
      slot.pokeItem = -1;
      slot.tip.visible = false;
    }
    menuOpen = false;
    menuPending = false;
    if (menu) menu.mesh.visible = false;
    // 触れられる物の縁の光を消す
    for (let i = 0; i < touchables.length; i++) {
      if (levels[i] > 0) touchables[i].setHighlight(0);
    }
    levels.fill(0);
    gazeIndex = -1;
    gazeTime = 0;
    gazeFired = false;
    session = null;
    ready = false;
  }

  function finish() {
    if (!session) return;
    renderer.xr.removeEventListener('sessionend', onSessionEnd);
    detach();
    renderer.xr.enabled = false;
    for (const fn of [...endListeners]) {
      try {
        fn();
      } catch (err) {
        console.error('[xr] onSessionEnd の受け手で例外', err);
      }
    }
  }

  function onSessionEnd() {
    finish();
  }

  // ───────────────────────────── 台の置き方 ─────────────────────────────

  /** 最初の数フレームで頭の高さと向きを測り、台の高さと正面を合わせる */
  function calibrate() {
    const frame = renderer.xr.getFrame();
    const space = renderer.xr.getReferenceSpace();
    if (!frame || !space) return;
    const vp = frame.getViewerPose(space);
    if (!vp) return;
    const p = vp.transform.position;
    const q = vp.transform.orientation;
    headX = p.x;
    headY = p.y;
    headZ = p.z;
    headYaw = yawFromQuaternion(q.x, q.y, q.z, q.w);
    recenterOffset = recenterYaw(headYaw);
    calibrated = true;
    needsCalibrate = false;
    // ヘッドセットの「中心を合わせ直す」操作でも、ゴンドラの正面を保つ
    if (space !== watchedSpace) {
      watchedSpace = space;
      try {
        space.addEventListener('reset', () => {
          needsCalibrate = true;
        });
      } catch {
        // 古い実装では reset がない。その場合は recenter() を呼んでもらう
      }
    }
  }

  function placeRig(pose: RidePose) {
    const yaw = pose.yaw + recenterOffset;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    // 合わせた時点の頭の位置が、ゴンドラの座席の真上に来るようにずらす（台は座席の周りに回る）
    const hx = calibrated ? headX : 0;
    const hz = calibrated ? headZ : 0;
    rig.position.set(pose.x - (c * hx + s * hz), pose.y + rigHeightOffset(posture, calibrated ? headY : null), pose.z - (-s * hx + c * hz));
    rig.rotation.set(0, yaw, 0);
    rig.updateMatrixWorld(true);
  }

  /** 頭のワールド座標と前方（前のフレームの描画で更新されたカメラの行列から） */
  function readHead() {
    const e = deps.camera.matrixWorld.elements;
    _head.x = e[12];
    _head.y = e[13];
    _head.z = e[14];
    // 前方は -Z 軸
    let fx = -e[8];
    let fy = -e[9];
    let fz = -e[10];
    const len = Math.hypot(fx, fy, fz) || 1;
    fx /= len;
    fy /= len;
    fz /= len;
    _head.dx = fx;
    _head.dy = fy;
    _head.dz = fz;
  }

  // ───────────────────────────── 外周の暗さ ─────────────────────────────

  function updateVignette(dt: number, real: number, pose: RidePose) {
    let target = 0;
    // ポーズ中（dt が 0）は止まっているので 0 に戻す
    if (dt > 1e-4) {
      let yawRateDeg = 0;
      if (haveLastYaw && dt < 0.25) yawRateDeg = (Math.abs(wrapAngle(pose.yaw - lastYaw)) / dt) * RAD2DEG;
      target = vignetteFor(pose.speed, yawRateDeg, vignetteSetting);
    }
    lastYaw = pose.yaw;
    haveLastYaw = true;
    vignetteNow = damp(vignetteNow, target, XR_TUNING.vignetteHalfLife, real);
    vignette?.set(vignetteNow);
  }

  // ───────────────────────────── 指先 ─────────────────────────────

  function collectTips() {
    for (const slot of slots) {
      slot.valid = false;
      slot.tip.visible = false;
      const src = slot.source;
      if (!src) continue;
      let local: THREE.Vector3 | null = null;
      if (src.hand) {
        const joint = slot.hand.joints['index-finger-tip'];
        if (joint && joint.visible) local = joint.position;
      } else if (src.targetRayMode === 'tracked-pointer' && slot.ray.visible) {
        local = slot.ray.position;
      }
      if (!local) continue;
      slot.tip.position.copy(local);
      slot.tip.visible = true;
      _v.copy(local).applyMatrix4(rig.matrixWorld);
      slot.x = _v.x;
      slot.y = _v.y;
      slot.z = _v.z;
      slot.valid = true;
    }
  }

  /** コントローラー（または手のつまみ）の光線を、台の局所の姿勢から世界の座標で _o と _d に書く */
  function rayOf(slot: Slot): boolean {
    if (!slot.source || slot.source.targetRayMode === 'gaze' || !slot.ray.visible) return false;
    _m.multiplyMatrices(rig.matrixWorld, slot.ray.matrix);
    const e = _m.elements;
    _o.set(e[12], e[13], e[14]);
    _d.set(-e[8], -e[9], -e[10]).normalize();
    return true;
  }

  function buzz(slot: Slot) {
    try {
      const act = slot.source?.gamepad?.hapticActuators?.[0] as unknown as { pulse?: (v: number, ms: number) => Promise<boolean> } | undefined;
      void act?.pulse?.(XR_TUNING.hapticStrength, XR_TUNING.hapticMs)?.catch(() => {});
    } catch {
      // 振動が使えない端末は何もしない
    }
  }

  // ───────────────────────────── 触れる ─────────────────────────────

  function fire(t: Touchable, x: number, y: number, z: number, source: TouchSource) {
    const point: Vec3Tuple = [x, y, z];
    touchCount++;
    // 0.1秒以内に応える: まず物へ、続けて音などの受け手へ
    t.onTouch({ t: lastT, source, point });
    deps.events.emit('touch', { touchableId: t.id, kind: t.kind, section: t.section, position: point, source, t: lastT });
  }

  function onSelectStart(slot: Slot) {
    if (!session) return;
    if (!rayOf(slot)) return;
    if (menuOpen) {
      const item = menuItemAtRay();
      if (item >= 0) selectMenu(item, slot);
      return;
    }
    if (rayTouchable(_o.x, _o.y, _o.z, _d.x, _d.y, _d.z, touchables, XR_TUNING.gazeSlackDeg, rayHit)) {
      const p = rayHit.along;
      fire(touchables[rayHit.index], _o.x + _d.x * p, _o.y + _d.y * p, _o.z + _d.z * p, 'xr');
      buzz(slot);
    }
  }

  function updateTouchables(real: number) {
    const list = touchables;
    readHead();

    // 1. 指先で触れる。同じ物は指が離れるまで繰り返さない
    for (const slot of slots) {
      if (!slot.valid) {
        slot.held = null;
        continue;
      }
      if (nearestTouchable(slot.x, slot.y, slot.z, list, INTERACTION.xrTouchDistance, near)) {
        const t = list[near.index];
        if (slot.held !== t) {
          slot.held = t;
          fire(t, slot.x, slot.y, slot.z, 'xr');
          buzz(slot);
        }
      } else {
        slot.held = null;
      }
    }

    // 2. 見つめて触れる（INT-2）。頭の正面の光線が同じ物に設定の秒数あたり続けば触れる。外れたら数え直す
    if (rayTouchable(_head.x, _head.y, _head.z, _head.dx, _head.dy, _head.dz, list, XR_TUNING.gazeSlackDeg, rayHit)) {
      if (rayHit.index !== gazeIndex) {
        gazeIndex = rayHit.index;
        gazeTime = 0;
        gazeFired = false;
      } else {
        gazeTime += real;
        if (!gazeFired && gazeTime >= gazeDwell) {
          gazeFired = true;
          const p = rayHit.along;
          fire(list[gazeIndex], _head.x + _head.dx * p, _head.y + _head.dy * p, _head.z + _head.dz * p, 'gaze');
        }
      }
    } else {
      gazeIndex = -1;
      gazeTime = 0;
      gazeFired = false;
    }
    const gazeProgress = gazeIndex >= 0 ? Math.min(1, gazeTime / gazeDwell) : 0;

    // 3. 近づくと縁がかすかに光る（INT-1）。指先が近いほど、見つめているほど強く
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      let level = 0;
      if (t.enabled) {
        const c = t.object.matrixWorld.elements;
        const hd = Math.sqrt((c[12] - _head.x) ** 2 + (c[13] - _head.y) ** 2 + (c[14] - _head.z) ** 2) - t.radius;
        level = XR_TUNING.proximityGlowMax * (1 - smoothstep(1, INTERACTION.highlightDistance, hd));
        for (const slot of slots) {
          if (!slot.valid) continue;
          const fd = Math.sqrt((c[12] - slot.x) ** 2 + (c[13] - slot.y) ** 2 + (c[14] - slot.z) ** 2) - t.radius;
          const g = 1 - smoothstep(INTERACTION.xrTouchDistance, INTERACTION.xrTouchDistance + XR_TUNING.fingerNearReach, fd);
          if (g > level) level = g;
        }
        if (i === gazeIndex) level = Math.max(level, 0.6 + 0.4 * gazeProgress);
      }
      // 変わったときだけ部屋へ伝える
      if (Math.abs(level - levels[i]) > 0.02 || (level === 0 && levels[i] !== 0)) {
        levels[i] = level;
        t.setHighlight(level);
      }
    }
  }

  // ───────────────────────────── メニュー ─────────────────────────────

  /** 世界の光線（_o, _d）が板に当たる項目の番号。板の座標系に直して交差を見る */
  function menuItemAtRay(): number {
    if (!menu) return -1;
    _inv.copy(menu.mesh.matrixWorld).invert();
    _o.applyMatrix4(_inv);
    _d.transformDirection(_inv);
    if (_o.z < 0 || Math.abs(_d.z) < 1e-6) return -1;
    const s = -_o.z / _d.z;
    if (s <= 0 || s > 6) return -1;
    return menu.hit(_o.x + _d.x * s, _o.y + _d.y * s);
  }

  function selectMenu(index: number, slot: Slot | null) {
    if (!menu) return;
    const item = menuItems[index];
    if (!item) return;
    menu.flash(index);
    if (slot) buzz(slot);
    const cb = menuCallback;
    cb?.(item.id);
  }

  function openMenu() {
    if (!menu) {
      menu = createMenu();
      rig.add(menu.mesh);
    }
    menu.setItems(menuItems);
    // 頭の前方 XR.menuDistance、目より少し下。台の局所座標で置くので、ゴンドラが動いてもついていく
    let hx = headX;
    let hy = headY;
    let hz = headZ;
    let hyaw = headYaw;
    if (frames > 2) {
      const cam = deps.camera;
      hx = cam.position.x;
      hy = cam.position.y;
      hz = cam.position.z;
      hyaw = yawFromQuaternion(cam.quaternion.x, cam.quaternion.y, cam.quaternion.z, cam.quaternion.w);
    }
    const p = menuPose({ x: hx, y: hy, z: hz, yaw: hyaw });
    menu.mesh.position.set(p.x, p.y, p.z);
    menu.mesh.rotation.set(0, p.yaw, 0);
    menu.mesh.visible = true;
    menu.mesh.updateMatrixWorld(true);
    menuOpen = true;
    menuPending = false;
    menuGazeIndex = -1;
    menuGazeTime = 0;
    menuGazeFired = false;
    for (const slot of slots) slot.pokeItem = -1;
    // メニューのあいだは物を見つめない・光らせない
    for (let i = 0; i < touchables.length; i++) {
      if (levels[i] > 0) {
        levels[i] = 0;
        touchables[i].setHighlight(0);
      }
    }
    gazeIndex = -1;
    gazeTime = 0;
    gazeFired = false;
  }

  function updateMenu(real: number) {
    if (!menu) return;
    readHead();
    _inv.copy(menu.mesh.matrixWorld).invert();
    let hover = -1;

    // 1. 手や指先で直接押す: 板の手前に入り、板の奥に抜けきらないうちに押したことにする
    for (const slot of slots) {
      if (!slot.valid) {
        slot.pokeItem = -1;
        continue;
      }
      _v.set(slot.x, slot.y, slot.z).applyMatrix4(_inv);
      const item = menu.hit(_v.x, _v.y);
      const inZone = item >= 0 && _v.z >= -XR_TUNING.menuPokeBehind && _v.z <= XR_TUNING.fingerNearReach;
      if (inZone) {
        hover = item;
        if (_v.z <= INTERACTION.xrTouchDistance && slot.pokeItem !== item) {
          slot.pokeItem = item;
          selectMenu(item, slot);
        }
      } else if (slot.pokeItem !== -1) {
        slot.pokeItem = -1;
      }
    }

    // 2. コントローラーで指す（トリガーは onSelectStart）
    if (hover < 0) {
      for (const slot of slots) {
        if (!rayOf(slot)) continue;
        const item = menuItemAtRay();
        if (item >= 0) {
          hover = item;
          break;
        }
      }
    }

    // 3. 見つめる: 同じ項目を設定の秒数見つめると選ぶ。外れたら数え直す
    _o.set(_head.x, _head.y, _head.z);
    _d.set(_head.dx, _head.dy, _head.dz);
    const gazeItem = menuItemAtRay();
    if (gazeItem >= 0) {
      if (gazeItem !== menuGazeIndex) {
        menuGazeIndex = gazeItem;
        menuGazeTime = 0;
        menuGazeFired = false;
      } else {
        menuGazeTime += real;
        if (!menuGazeFired && menuGazeTime >= gazeDwell) {
          menuGazeFired = true;
          selectMenu(gazeItem, null);
        }
      }
      if (hover < 0) hover = gazeItem;
    } else {
      menuGazeIndex = -1;
      menuGazeTime = 0;
      menuGazeFired = false;
    }
    menu?.setHover(hover);
  }

  // ───────────────────────────── 契約 ─────────────────────────────

  return {
    async isSupported() {
      try {
        const nav = typeof navigator === 'undefined' ? undefined : navigator.xr;
        return (await nav?.isSessionSupported('immersive-vr')) ?? false;
      } catch {
        return false;
      }
    },

    get active() {
      return session !== null && ready;
    },

    rig,

    async enter(requested) {
      if (session) return;
      const nav = typeof navigator === 'undefined' ? undefined : navigator.xr;
      if (!nav) throw new Error('この端末のブラウザは WebXR に対応していません');
      const backend = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
      if (backend?.isWebGPUBackend === true) {
        throw new Error('VR は WebGL2 の経路で描きます。描画器を forceWebGL で作ってください');
      }
      posture = requested;
      const s = await nav.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'hand-tracking'] });
      // local-floor が許されなかった端末では、立って乗る場合も local で測る（高さは頭から測るので困らない）
      const granted = (s as unknown as { enabledFeatures?: readonly string[] }).enabledFeatures;
      refSpace = referenceSpaceFor(posture);
      if (refSpace === 'local-floor' && granted && !granted.includes('local-floor')) refSpace = 'local';
      renderer.xr.enabled = true;
      renderer.xr.setReferenceSpaceType(refSpace);
      tolerateNullFramebuffer(renderer);
      attach(s);
      try {
        await renderer.xr.setSession(s);
      } catch (err) {
        renderer.xr.removeEventListener('sessionend', onSessionEnd);
        detach();
        renderer.xr.enabled = false;
        try {
          await s.end();
        } catch {
          // すでに終わっている
        }
        throw err;
      }
      // 開始の途中でヘッドセットが外されるなどして、すでに終わっていた
      if (session !== s) throw new Error('VR のセッションが始まる前に終わりました');
      ready = true;
    },

    async exit() {
      const s = session;
      if (!s) return;
      try {
        await s.end();
      } catch {
        // すでに終わっている
      }
      // sessionend が来ていなければ（実装によっては end() の後）、ここで片付ける
      if (session === s) finish();
    },

    update(t, dt, pose) {
      if (!session || !ready) return;
      const nowMs = performance.now();
      // 見つめる秒数などは壁時計で数える（ポーズ中は乗車の時計が止まるが、メニューは見つめて選べる）
      const real = Math.min(0.1, Math.max(0, (nowMs - lastMs) / 1000));
      lastMs = nowMs;
      lastT = t;
      frames++;
      if (needsCalibrate) calibrate();
      placeRig(pose);
      updateVignette(dt, real, pose);
      collectTips();
      if (menuPending && calibrated) openMenu();
      if (menuOpen) updateMenu(real);
      else updateTouchables(real);
    },

    setTouchables(list) {
      const prev = new Map<Touchable, number>();
      for (let i = 0; i < touchables.length; i++) prev.set(touchables[i], levels[i]);
      const next = new Float32Array(list.length);
      const kept = new Set(list);
      for (let i = 0; i < list.length; i++) next[i] = prev.get(list[i]) ?? 0;
      // 外れた物の縁の光は消す
      for (const [t, level] of prev) if (!kept.has(t) && level > 0) t.setHighlight(0);
      touchables = list;
      levels = next;
      gazeIndex = -1;
      gazeTime = 0;
      gazeFired = false;
      for (const slot of slots) slot.held = null;
    },

    recenter() {
      if (session) needsCalibrate = true;
    },

    setVignette(strength) {
      vignetteSetting = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0;
    },

    showMenu(items, onSelect) {
      menuItems = items;
      menuCallback = onSelect;
      if (session && calibrated) openMenu();
      else menuPending = true;
    },

    hideMenu() {
      menuOpen = false;
      menuPending = false;
      menuCallback = null;
      if (menu) menu.mesh.visible = false;
    },

    onSessionEnd(fn) {
      endListeners.push(fn);
    },

    setGazeDwell(sec) {
      if (Number.isFinite(sec) && sec > 0) gazeDwell = sec;
    },

    debugInfo() {
      return {
        active: session !== null && ready,
        referenceSpace: refSpace,
        calibrated,
        headHeight: headY,
        headYawDeg: headYaw * RAD2DEG,
        vignette: vignetteNow,
        menuOpen,
        sources: slots.filter((s) => s.source).map((s) => ({ hand: !!s.source?.hand, mode: s.source?.targetRayMode ?? '' })),
        touches: touchCount,
      };
    },
  };
}
