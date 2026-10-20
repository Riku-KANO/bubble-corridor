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
  createRayCandidates,
  menuPose,
  nearestTouchable,
  rayCandidates,
  recenterYaw,
  referenceSpaceFor,
  rigHeightOffset,
  vignetteFor,
  whiteoutOpacity,
  yawFromQuaternion,
  type Nearest,
} from './logic';
import { createMenu, type MenuItem, type MenuPanel } from './menu';
import { XR_TUNING } from './tuning';
import { createVignette, type Vignette } from './vignette';
import { createWhiteout, type Whiteout } from './whiteout';

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
  /** 白い霧の不透明度（セッション開始で 1、1 秒で晴れる） */
  readonly whiteout: number;
  readonly menuOpen: boolean;
  /** メニューの見つめ: 数え始めてよいか（開いた直後は視線が一度外れるまで数えない）と、その進み具合 */
  readonly menuGaze: { readonly armed: boolean; readonly progress: number };
  readonly sources: readonly { readonly hand: boolean; readonly mode: string }[];
  readonly touches: number;
}

/**
 * three r186 の WebGL バックエンドの穴を、必要なときだけふさぐ回避策。
 *
 * 原因: WebGLState.drawBuffers は、描画先の framebuffer を WeakMap（backend.state.currentDrawbuffers）の鍵にする。
 * XRWebGLLayer のフォールバック経路では XRManager が backend.setXRTarget(glBaseLayer.framebuffer) を呼ぶので、
 * framebuffer が null（既定のフレームバッファ）だと「Invalid value used as weak map key」で毎フレーム描画が落ちる。
 *
 * 効く範囲: IWER（エミュレーション。XRWebGLLayer.framebuffer が null）の e2e だけ。実機のブラウザは
 * 投影レイヤー（XRWebGLBinding）や null でない framebuffer を返すので起きない。だから baseLayer.framebuffer が
 * null のときだけ差し替える（実機では何もしない）。鍵が null の分だけ別に持つ WeakMap にして直す。
 *
 * 外す条件: three が WeakMap に null を渡さなくなった（または null を許す）版に上げ、この関数を外しても
 * e2e/xr.spec.ts（IWER）が通ること。three 側の不具合として報告する価値がある。
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

let warnedThreeInternals = false;

/**
 * setSession の直後に呼ぶ。差し替えが必要なのにできなかったら、一度だけ console.warn する。
 * 描画の層は session.renderState.baseLayer ではなく renderer.xr.getBaseLayer()（three が作った層）で見る。
 * updateRenderState の結果は次のフレームまで renderState に現れないので、setSession の直後はまだ入っていない。
 * 投影レイヤー（XRProjectionLayer）には framebuffer がない（undefined）ので、実機の経路は対象外。
 */
function tolerateNullFramebuffer(renderer: THREE.WebGPURenderer) {
  const layer = renderer.xr.getBaseLayer() as { framebuffer?: unknown } | null;
  if (!layer || layer.framebuffer !== null) return;
  const state = (renderer as unknown as { backend?: { state?: { currentDrawbuffers?: unknown } } }).backend?.state;
  if (state?.currentDrawbuffers instanceof NullKeyWeakMap) return;
  if (state?.currentDrawbuffers instanceof WeakMap) {
    state.currentDrawbuffers = new NullKeyWeakMap();
    return;
  }
  if (!warnedThreeInternals) {
    warnedThreeInternals = true;
    console.warn('[xr] three の内部が変わった（backend.state.currentDrawbuffers が見つからない）。framebuffer が null の XR（IWER）では描けない');
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
  /** メニューを開いたとき、すでに指が板の手前にあった。板から離れるまで押しを無効にする */
  pokeLock: boolean;
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
  /** カメラを台へ移し、台をシーンに置いた状態か。detach を二重に走らせない（二度目はカメラの親を失う） */
  let attached = false;
  /** setSession が終わり、次のフレームから XR で描ける。それまでは active にしない（enter の完了と同時に true になる） */
  let ready = false;
  /** enter の最中の Promise。続けて呼ばれても requestSession を二重にしない */
  let entering: Promise<void> | null = null;
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
  let calibrateTries = 0;
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

  // ── 画面 → VR の白い霧（セッション開始からの時刻で決める） ──
  let whiteout: Whiteout | null = null;
  /** 頭の高さと正面を合わせ終えた時刻（ms）。それまでは霧を晴らさない（-1: まだ） */
  let fogStartMs = -1;
  let whiteoutNow = 1;

  // ── 触れる ──
  let touchables: readonly Touchable[] = [];
  let levels = new Float32Array(0);
  let gazeDwell: number = INTERACTION.gazeDwellSec;
  let gazeIndex = -1;
  let gazeTime = 0;
  let gazeFired = false;
  let touchCount = 0;
  const near: Nearest = { index: -1, distance: Infinity };
  // 光線の判定: 前段の球（候補を手前から数個）→ 表面を Raycaster で確かめる
  const candidates = createRayCandidates(XR_TUNING.rayCandidates);
  const raycaster = new THREE.Raycaster();
  raycaster.camera = deps.camera;
  const rayScratch: THREE.Intersection[] = [];
  const pick = { index: -1, along: 0, x: 0, y: 0, z: 0 };

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
  /** 開いた直後に視線があった項目（-1: 項目に当たっていない、-2: まだ測っていない）。ここから外れるまで数えない */
  let menuGazeFirst = -2;
  let menuGazeArmed = false;
  let menuGazeProgress = 0;

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
      const slot: Slot = { ray, hand, tip, source: null, held: null, pokeItem: -1, pokeLock: false, valid: false, x: 0, y: 0, z: 0 };
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

  function ensureMenu() {
    if (menu) return;
    menu = createMenu();
    rig.add(menu.mesh);
  }

  function attach(s: XRSession) {
    session = s;
    attached = true;
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
    // 白い霧は始まりで 1（最初のフレームから視界を覆う）。晴れ方は update で時刻から決める
    if (!whiteout) whiteout = createWhiteout();
    cam.add(whiteout.mesh);
    whiteout.set(1);
    whiteoutNow = 1;
    fogStartMs = -1;
    ensureMenu();
    needsCalibrate = true;
    calibrated = false;
    calibrateTries = 0;
    frames = 0;
    haveLastYaw = false;
    vignetteNow = 0;
    lastMs = performance.now();
    renderer.xr.addEventListener('sessionend', onSessionEnd);
  }

  function detach() {
    // 二度目はカメラの親（camParent）がもう無いので、カメラを台から外したまま戻せなくなる。一度だけ行う
    if (!attached) return;
    attached = false;
    const cam = deps.camera;
    cam.removeFromParent();
    if (camParent) camParent.add(cam);
    cam.position.copy(camSaved.position);
    cam.quaternion.copy(camSaved.quaternion);
    cam.scale.copy(camSaved.scale);
    camParent = null;
    vignette?.mesh.removeFromParent();
    vignette?.set(0);
    whiteout?.mesh.removeFromParent();
    whiteout?.set(0);
    deps.scene.remove(rig);
    for (const slot of slots) {
      slot.held = null;
      slot.valid = false;
      slot.pokeItem = -1;
      slot.pokeLock = false;
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
    // 頭の位置が推定（首のモデル）のうちは測らない。追跡が始まってから測り直す。
    // 3DoF だけの機器は推定のままなので、待つのは数フレームまでにして、そのあとは推定で測る
    if (vp.emulatedPosition && calibrateTries++ < XR_TUNING.calibrateWaitFrames) return;
    const p = vp.transform.position;
    const q = vp.transform.orientation;
    headX = p.x;
    headY = p.y;
    headZ = p.z;
    headYaw = yawFromQuaternion(q.x, q.y, q.z, q.w);
    recenterOffset = recenterYaw(headYaw);
    calibrated = true;
    needsCalibrate = false;
    // 白い霧は、最初に合わせ終えた時点から晴らし始める
    if (fogStartMs < 0) fogStartMs = performance.now();
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
      slot.tip.scale.setScalar(1);
      slot.tip.visible = true;
      _v.copy(local).applyMatrix4(rig.matrixWorld);
      slot.x = _v.x;
      slot.y = _v.y;
      slot.z = _v.z;
      slot.valid = true;
    }
  }

  /**
   * コントローラーの光線を、台の局所の姿勢から世界の座標で _o と _d に書く。
   * 光線は tracked-pointer のコントローラーだけ。手（ハンドトラッキング）は指先の距離で触れるだけで、
   * つまむ・指すは作らない（設計書「決めたこと」）。
   */
  function rayOf(slot: Slot): boolean {
    const src = slot.source;
    if (!src || src.hand || src.targetRayMode !== 'tracked-pointer' || !slot.ray.visible) return false;
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

  /**
   * 光線（_o, _d）の候補を集めて候補の数を返す（前段）。物の原点中心の球（半径 + 距離に比例する余裕）で、
   * 見つめる距離の上限（INTERACTION.gazeMaxDistance、表面まで）内のものを手前から数個に絞る。
   */
  function gatherCandidates(): number {
    return rayCandidates(_o.x, _o.y, _o.z, _d.x, _d.y, _d.z, touchables, XR_TUNING.gazeSlackDeg, INTERACTION.gazeMaxDistance, candidates);
  }

  /** 物 t の表面に光線（_o, _d）が当たる点を、当たるなら hit に写して true を返す */
  function surfaceHit(t: Touchable, along: number): THREE.Intersection | null {
    raycaster.ray.origin.copy(_o);
    raycaster.ray.direction.copy(_d);
    raycaster.near = 0;
    raycaster.far = along + t.radius + 1;
    rayScratch.length = 0;
    raycaster.intersectObject(t.object, true, rayScratch);
    return rayScratch.length > 0 ? rayScratch[0] : null;
  }

  /** 後段: 候補のうち、表面を Raycaster で確かめて最初に当たる物と、その表面の点を pick に書く */
  function pickSurface(n: number): boolean {
    for (let k = 0; k < n; k++) {
      const i = candidates.index[k];
      const h = surfaceHit(touchables[i], candidates.along[k]);
      if (h) {
        pick.index = i;
        pick.along = candidates.along[k];
        pick.x = h.point.x;
        pick.y = h.point.y;
        pick.z = h.point.z;
        return true;
      }
    }
    return false;
  }

  /** 物 i に触れる点を決めて触れる。表面に当たればその点、外れていれば（見つめの揺れ）光線の最接近点 */
  function fireOnSurface(i: number, along: number, source: TouchSource) {
    const t = touchables[i];
    const h = surfaceHit(t, along);
    if (h) fire(t, h.point.x, h.point.y, h.point.z, source);
    else fire(t, _o.x + _d.x * along, _o.y + _d.y * along, _o.z + _d.z * along, source);
  }

  function onSelectStart(slot: Slot) {
    if (!session) return;
    // 手のつまみ（selectstart）では何も起きない。光線で触れる・メニューを選ぶのは tracked-pointer のコントローラーだけ
    if (slot.source?.hand) return;
    if (!rayOf(slot)) return;
    if (menuOpen) {
      const item = menuItemAtRay();
      if (item >= 0) selectMenu(item, slot);
      return;
    }
    // 指す: 前段の候補のうち、表面に当たる最初の物（表面の点で触れる）
    if (pickSurface(gatherCandidates())) {
      fire(touchables[pick.index], pick.x, pick.y, pick.z, 'xr');
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

    // 2. 見つめて触れる（INT-2）。頭の正面の光線が同じ物に設定の秒数あたり続けば触れる。外れたら数え直す。
    //    見つめる距離には上限がある（INTERACTION.gazeMaxDistance、物の表面まで）。
    //    見つめている物は球の判定だけで保つ（毎フレームの Raycaster をやめ、頭の揺れでも数え直しにならない）。
    //    表面を確かめるのは、新しい物に移るときと、触れる点を決めるときだけ
    _o.set(_head.x, _head.y, _head.z);
    _d.set(_head.dx, _head.dy, _head.dz);
    const n = gatherCandidates();
    let target = -1;
    let targetAlong = 0;
    if (gazeIndex >= 0) {
      for (let k = 0; k < n; k++) {
        if (candidates.index[k] === gazeIndex) {
          target = gazeIndex;
          targetAlong = candidates.along[k];
          break;
        }
      }
    }
    if (target < 0 && n > 0 && pickSurface(n)) {
      target = pick.index;
      targetAlong = pick.along;
    }
    if (target >= 0) {
      if (target !== gazeIndex) {
        gazeIndex = target;
        gazeTime = 0;
        gazeFired = false;
      } else {
        gazeTime += real;
        if (!gazeFired && gazeTime >= gazeDwell) {
          gazeFired = true;
          // 触れた点は、見つめ終わりの表面の点
          fireOnSurface(gazeIndex, targetAlong, 'gaze');
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
    ensureMenu();
    const panel = menu;
    if (!panel) return;
    panel.setItems(menuItems);
    panel.prewarm(false); // 白い霧のあいだの先描画（不透明度 0）が残っていても、ここで元に戻す
    // 頭の前方 XR.menuDistance、板の中心は目の約 0.12m 下。背の高い板は、下端が視野の下 menuMaxDownDeg に収まるよう
    // 中心を上げる（ゴンドラの手すり、目の約 0.5m 下に隠れない）。台の局所座標で置くので、ゴンドラが動いてもついていく
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
    const lowest = hy - XR.menuDistance * Math.tan((XR_TUNING.menuMaxDownDeg * Math.PI) / 180);
    panel.mesh.position.set(p.x, Math.max(p.y, lowest + panel.height / 2), p.z);
    panel.mesh.rotation.set(0, p.yaw, 0);
    panel.mesh.visible = true;
    panel.mesh.updateMatrixWorld(true);
    menuOpen = true;
    menuPending = false;
    menuGazeIndex = -1;
    menuGazeTime = 0;
    menuGazeFired = false;
    // 開いた直後は、視線がいる項目も数えない（視線が一度外れるか、別の項目に移ってから数える）
    menuGazeFirst = -2;
    menuGazeArmed = false;
    menuGazeProgress = 0;
    panel.setProgress(-1, 0);
    // 開いた直後に指が板の手前に残っていたら、離れるまで押しを無効にする
    _inv.copy(panel.mesh.matrixWorld).invert();
    for (const slot of slots) {
      slot.pokeItem = -1;
      slot.pokeLock = false;
      if (!slot.valid) continue;
      _v.set(slot.x, slot.y, slot.z).applyMatrix4(_inv);
      slot.pokeLock = inMenuZone(panel, _v);
    }
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

  /** 板の座標の点が、板の手前の押せる範囲（板の面の内側、手前 fingerNearReach から奥 menuPokeBehind まで）にあるか */
  function inMenuZone(panel: MenuPanel, local: THREE.Vector3): boolean {
    return (
      Math.abs(local.x) <= panel.width / 2 &&
      Math.abs(local.y) <= panel.height / 2 &&
      local.z >= -XR_TUNING.menuPokeBehind &&
      local.z <= XR_TUNING.fingerNearReach
    );
  }

  function updateMenu(real: number) {
    const panel = menu;
    if (!panel) return;
    readHead();
    _inv.copy(panel.mesh.matrixWorld).invert();
    let hover = -1;

    // 1. 手や指先で直接押す: 板の手前に入り、板の奥に抜けきらないうちに押したことにする。
    //    開いた直後に板の手前に残っていた指は、一度離れるまで押せない
    for (const slot of slots) {
      if (!slot.valid) {
        slot.pokeItem = -1;
        slot.pokeLock = false;
        continue;
      }
      _v.set(slot.x, slot.y, slot.z).applyMatrix4(_inv);
      if (slot.pokeLock) {
        if (inMenuZone(panel, _v)) continue;
        slot.pokeLock = false;
      }
      const item = panel.hit(_v.x, _v.y);
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

    // 2. コントローラーで指す（トリガーは onSelectStart）。手には光線がない
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

    // 3. 見つめる: 同じ項目を設定の秒数見つめると選ぶ。外れたら数え直す。
    //    開いた直後は、視線がいた項目から外れる（または別の項目に移る）まで数えない
    _o.set(_head.x, _head.y, _head.z);
    _d.set(_head.dx, _head.dy, _head.dz);
    const gazeItem = menuItemAtRay();
    if (menuGazeFirst === -2) {
      menuGazeFirst = gazeItem;
      menuGazeArmed = gazeItem < 0;
    } else if (!menuGazeArmed && gazeItem !== menuGazeFirst) {
      menuGazeArmed = true;
    }
    menuGazeProgress = 0;
    if (menuGazeArmed && gazeItem >= 0) {
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
      menuGazeProgress = menuGazeFired ? 1 : Math.min(1, menuGazeTime / gazeDwell);
      if (hover < 0) hover = gazeItem;
    } else {
      menuGazeIndex = -1;
      menuGazeTime = 0;
      menuGazeFired = false;
    }
    panel.setHover(hover);
    // 項目の上に、見つめた進み具合の塗り
    panel.setProgress(menuGazeArmed ? gazeItem : -1, menuGazeProgress);
  }

  // ───────────────────────────── 開始 ─────────────────────────────

  /**
   * 白い霧のあいだ（最初の約 1 秒）に、外周の暗さ・メニュー・指先を不透明度 0（指先は極小）で一度描く。
   * XR の描画ではカメラが ArrayCamera になり、通常のカメラとは別のシェーダが要る。それを開始前に compileAsync しても
   * 作れず、WebGL バックエンドの完了待ちが window の rAF に頼るため、没入中に rAF が止まる端末では開始が止まる。
   * だから開始前には何もせず、最初のフレームの描画で作る（同期で作られ、引っかかりは霧に隠れる）。
   */
  function warmUp() {
    vignette?.prewarm();
    if (!menuOpen) menu?.prewarm(true);
    for (const slot of slots) {
      if (slot.valid) continue;
      slot.tip.scale.setScalar(0.001);
      slot.tip.visible = true;
    }
  }

  /** 開始の途中で終わった・失敗したときの後片付け。すでに片付いていれば（sessionend が先に走った）何もしない */
  async function abandon(s: XRSession) {
    if (session !== s) return;
    renderer.xr.removeEventListener('sessionend', onSessionEnd);
    detach();
    renderer.xr.enabled = false;
    session = null;
    ready = false;
    try {
      await s.end();
    } catch {
      // すでに終わっている
    }
  }

  async function doEnter(requested: XRPosture): Promise<void> {
    const nav = typeof navigator === 'undefined' ? undefined : navigator.xr;
    if (!nav) throw new Error('この端末のブラウザは WebXR に対応していません');
    const backend = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
    if (backend?.isWebGPUBackend === true) {
      throw new Error('VR は WebGL2 の経路で描きます。描画器を forceWebGL で作ってください');
    }
    posture = requested;
    const s = await nav.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'hand-tracking'] });
    // 開始の途中で終わったことを記録する（ヘッドセットが外された、など）
    let ended = false;
    s.addEventListener('end', () => (ended = true), { once: true });
    // local-floor が許されなかった端末では、立って乗る場合も local で測る（高さは頭から測るので困らない）
    const granted = (s as unknown as { enabledFeatures?: readonly string[] }).enabledFeatures;
    refSpace = referenceSpaceFor(posture);
    if (refSpace === 'local-floor' && granted && !granted.includes('local-floor')) refSpace = 'local';
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType(refSpace);
    attach(s);
    // すでに終わっていたら、setSession を呼ばずに片付けて抜ける
    if (ended) {
      await abandon(s);
      throw new Error('VR のセッションが始まる前に終わりました');
    }
    try {
      await renderer.xr.setSession(s);
      // ここから最初の XR フレームまで、他の処理は挟まらない（続きのマイクロタスクは次のフレームより先に走る）
      tolerateNullFramebuffer(renderer);
      // three r186 の setSession は、投影レイヤーを作る前に foveation を当てるので、層に効かない。作った後に当て直す
      renderer.xr.setFoveation(XR_TUNING.foveation);
    } catch (err) {
      // 途中で終わっていたら、sessionend から finish → detach がすでに走っている（abandon は何もしない）
      await abandon(s);
      throw err;
    }
    if (session !== s || ended) {
      await abandon(s);
      throw new Error('VR のセッションが始まる前に終わりました');
    }
    whiteoutNow = 1;
    whiteout?.set(1);
    ready = true;
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

    enter(requested) {
      // 開始の最中に続けて呼ばれても、requestSession を二重にしない（同じ Promise を返す）
      if (session && ready) return Promise.resolve();
      if (entering) return entering;
      const p = doEnter(requested).finally(() => {
        entering = null;
      });
      entering = p;
      return p;
    },

    async exit() {
      // 開始の最中なら、終わるのを待ってから終える
      if (entering) {
        try {
          await entering;
        } catch {
          // 開始できなかった。終えるものはない
        }
      }
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
      // 白い霧: 頭の高さと正面を合わせ終えた時刻から数える（それまでは視界を覆ったまま、合わせ終えて 1 秒で晴れる）
      const fog = fogStartMs < 0 ? 1 : whiteoutOpacity((nowMs - fogStartMs) / 1000);
      if (fog !== whiteoutNow) {
        whiteoutNow = fog;
        whiteout?.set(fog);
      }
      updateVignette(dt, real, pose);
      collectTips();
      // 最初のフレームの描画で、外周の暗さ・メニュー・指先の XR 用シェーダを（霧に隠れて）作る
      if (frames === 1) warmUp();
      else if (frames === 2 && !menuOpen) menu?.prewarm(false);
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
      if (menu) {
        menu.mesh.visible = false;
        menu.setProgress(-1, 0);
      }
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
        whiteout: whiteoutNow,
        menuOpen,
        menuGaze: { armed: menuGazeArmed, progress: menuGazeProgress },
        sources: slots.filter((s) => s.source).map((s) => ({ hand: !!s.source?.hand, mode: s.source?.targetRayMode ?? '' })),
        touches: touchCount,
      };
    },
  };
}
