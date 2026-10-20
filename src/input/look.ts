// 見回し（CAM-1 / CAM-2 / INT-5）。カメラはゴンドラの座席に固定し、向き（yaw・pitch）だけを作る。
// yaw は左向きが正、pitch は上向きが正（three の Euler 'YXZ' にそのまま入れられる）。
//
// 向きは 3 つの足し合わせで決める:
//   base … ドラッグの積算、または追従モードのマウス位置、または「正面へ戻す」の途中経過
//   gyro … 端末の傾き（最初の向きからの差）
//   look = 範囲に収めた (base + gyro) へ、damp で寄せたもの
import { CAMERA } from '../config';
import type { InputDeps, LookControl, LookOptions, LookState } from '../contracts/input';
import { damp, easeGlass, lerp, wrapAngle } from '../core/easing';

const DEG = Math.PI / 180;
const YAW_MAX = CAMERA.yawRangeDeg * DEG;
const PITCH_MAX = CAMERA.pitchRangeDeg * DEG;

// ── 手触りの数（設計書に値がないので仮。config に足す候補として報告する） ──
/** ドラッグの追従の半減期（秒）。指に吸い付く手触りにするため短い */
const DRAG_HALF_LIFE = 0.05;
/** 追従モードの半減期（秒）。マウスの小さな揺れをならすため長め */
const FOLLOW_HALF_LIFE = 0.18;
/** 追従モードで、中央のこの割合（半幅に対して）は正面のまま。マウスを置いただけで流れないように */
const FOLLOW_DEAD_ZONE = 0.08;
/** 追従モードで、端のこの割合より外は最大の向き（ブラウザの縁までは届かないため） */
const FOLLOW_EDGE = 0.95;
/** 追従モードの曲線の指数。中央付近は細かく、端へ行くほど大きく振る */
const FOLLOW_CURVE = 1.5;
/** 画面の中央が指に 1:1 で付いてくる感度を作るときに使う縦の視野角。視野角の設定は契約の外なので既定を使う */
const SENSITIVITY_FOV = CAMERA.fovDeg * DEG;
/** 要素の高さが取れないときの代わり */
const FALLBACK_HEIGHT = 600;
/** 傾きの前向きベクトルが垂直に近いとき、yaw は定まらないので前の値を保つ */
const GYRO_VERTICAL_EPS = 0.2;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 追従モードの曲線。n は -1〜1（要素の中心からの位置）。戻り値も -1〜1 */
function followShape(n: number): number {
  const a = clamp((Math.abs(n) - FOLLOW_DEAD_ZONE) / (FOLLOW_EDGE - FOLLOW_DEAD_ZONE), 0, 1);
  return Math.sign(n) * Math.pow(a, FOLLOW_CURVE);
}

/**
 * deviceorientation（W3C: R = Rz(alpha)·Rx(beta)·Ry(gamma)）から、画面の向こうへ向かう視線（端末の背面側）の
 * 方位 yaw（左が正）と仰角 pitch（上が正）を求める。
 * 視線は画面の法線なので、画面を縦↔横に回しても変わらない（変わるのは画面まわりの回転だけで、
 * ゴンドラは常に水平なのでそれは使わない）。そのため screen.orientation は式に入らない。
 * 戻り値: yaw が定まらない（視線が真上・真下に近い）なら false。pitch は常に out.pitch に入る。
 */
function viewDirection(alphaDeg: number, betaDeg: number, gammaDeg: number, out: { yaw: number; pitch: number }): boolean {
  const a = alphaDeg * DEG;
  const b = betaDeg * DEG;
  const g = gammaDeg * DEG;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  const cg = Math.cos(g);
  const sg = Math.sin(g);
  // 端末の -Z（背面側）を地面の座標（東・北・上）で表したもの
  const east = -(ca * sg + sa * cg * sb);
  const north = -(sa * sg - ca * cg * sb);
  const up = -(cg * cb);
  out.pitch = Math.asin(clamp(up, -1, 1));
  if (Math.hypot(east, north) < GYRO_VERTICAL_EPS) return false;
  out.yaw = Math.atan2(-east, north);
  return true;
}

export function createLookControl(deps: InputDeps, opts: LookOptions): LookControl {
  const el = deps.element;
  let mode = opts.mode;
  let gyroOn = false;
  let enabled = false;
  let disposed = false;

  /** 公開する向き（滑らかにした値） */
  const look: LookState = { yaw: 0, pitch: 0 };
  const base = { yaw: 0, pitch: 0 };
  const gyro = { yaw: 0, pitch: 0 };

  // ── 正面へ戻す ──
  interface Recenter {
    readonly fromYaw: number;
    readonly fromPitch: number;
    readonly toYaw: number;
    readonly toPitch: number;
    readonly duration: number;
    elapsed: number;
  }
  let recenter: Recenter | null = null;

  // ── ドラッグ ──
  let dragId: number | null = null;
  let lastX = 0;
  let lastY = 0;

  // ── 端末の傾き ──
  const dev = { yaw: 0, pitch: 0 };
  const devBase = { yaw: 0, pitch: 0 };
  const devTmp = { yaw: 0, pitch: 0 };
  let hasDevBase = false;
  let hasDev = false;

  const elementHeight = () => {
    const h = el.getBoundingClientRect().height || el.clientHeight;
    return h > 0 ? h : FALLBACK_HEIGHT;
  };

  /** 1px のドラッグが何ラジアンか。画面の中央で、指に景色が 1:1 で付いてくる量 */
  const radPerPx = () => (2 * Math.tan(SENSITIVITY_FOV / 2)) / elementHeight();

  /** (base + gyro) を範囲に収め、はみ出した分は base に残さない（ドラッグを戻したとき即座に動くように） */
  function settleBase() {
    base.yaw = clamp(base.yaw + gyro.yaw, -YAW_MAX, YAW_MAX) - gyro.yaw;
    base.pitch = clamp(base.pitch + gyro.pitch, -PITCH_MAX, PITCH_MAX) - gyro.pitch;
  }

  // ── ポインター ──
  /** 追従モードでマウス（ペン）の位置を向きにする。指のタッチは常にドラッグ */
  const followsPointer = (e: PointerEvent) => mode === 'follow' && e.pointerType !== 'touch';

  function endDrag(e?: PointerEvent) {
    if (dragId === null) return;
    if (e && e.pointerId !== dragId) return;
    const id = dragId;
    dragId = null;
    try {
      if (el.hasPointerCapture?.(id)) el.releasePointerCapture(id);
    } catch {
      // 既に離れている
    }
  }

  function onPointerDown(e: PointerEvent) {
    if (!enabled || e.button !== 0) return;
    if (dragId !== null) return; // 2本目の指は見回しに使わない（1本指のドラッグだけ）
    if (followsPointer(e)) return;
    dragId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    recenter = null; // 触られたら操作を優先する
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {
      // 合成イベントなどで捕捉できなくても、要素の上のドラッグは動く
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (!enabled) return;
    if (dragId !== null && e.pointerId === dragId) {
      // ウィンドウの外でボタンを離した場合
      if ((e.pointerType ?? 'mouse') === 'mouse' && e.buttons === 0) {
        endDrag(e);
        return;
      }
      const k = radPerPx();
      // 景色をつかんで動かす: 左へドラッグ → 右を向く（yaw が減る）、上へドラッグ → 下を向く（pitch が減る）
      base.yaw += (e.clientX - lastX) * k;
      base.pitch += (e.clientY - lastY) * k;
      lastX = e.clientX;
      lastY = e.clientY;
      settleBase();
      return;
    }
    if (dragId === null && followsPointer(e)) {
      if (recenter) return; // 戻している間は、マウスが置いてあるだけの揺れで止めない
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
      base.yaw = -followShape(nx) * YAW_MAX; // 右 → 右を向く（yaw は負）
      base.pitch = -followShape(ny) * PITCH_MAX; // 上 → 上を向く（画面の y は下が正）
      settleBase();
    }
  }

  function onPointerEnd(e: PointerEvent) {
    endDrag(e);
  }

  // ── 端末の傾き ──
  function onOrientation(e: Event) {
    if (!enabled || !gyroOn) return;
    const { alpha, beta, gamma } = e as Event & { alpha: number | null; beta: number | null; gamma: number | null };
    if (alpha == null || beta == null || gamma == null) return; // センサーのない PC が値なしで 1 度だけ送る
    devTmp.yaw = dev.yaw;
    if (viewDirection(alpha, beta, gamma, devTmp)) dev.yaw = devTmp.yaw;
    dev.pitch = devTmp.pitch;
    hasDev = true;
    if (!hasDevBase) {
      // 最初の向きを正面にする。見た目は動かさない（base は変えず、差だけ 0 から始める）
      devBase.yaw = dev.yaw;
      devBase.pitch = dev.pitch;
      hasDevBase = true;
    }
    gyro.yaw = wrapAngle(dev.yaw - devBase.yaw);
    gyro.pitch = dev.pitch - devBase.pitch;
  }

  /** 傾きの基準を「いまの向き」に取り直し、見た目の向きは変えない（差を base に移す） */
  function rebaseGyro() {
    base.yaw += gyro.yaw;
    base.pitch += gyro.pitch;
    gyro.yaw = 0;
    gyro.pitch = 0;
    if (hasDev) {
      devBase.yaw = dev.yaw;
      devBase.pitch = dev.pitch;
    }
    settleBase();
  }

  function applyGyroOption(on: boolean) {
    if (on === gyroOn) return;
    gyroOn = on;
    if (on) {
      hasDevBase = false;
      hasDev = false;
      window.addEventListener('deviceorientation', onOrientation);
    } else {
      window.removeEventListener('deviceorientation', onOrientation);
      rebaseGyro(); // 切ったときに視界が跳ねないよう、いまの向きを base に残す
      hasDevBase = false;
      hasDev = false;
    }
  }

  // 触れる側の入力（touch）も同じ要素で pointerdown などを受ける。ここでは見回しに必要なものだけを受ける
  const prevTouchAction = el.style.touchAction;
  el.style.touchAction = 'none'; // ブラウザのスクロール・ズームに指の動きを取られない
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerEnd);
  el.addEventListener('pointercancel', onPointerEnd);
  el.addEventListener('lostpointercapture', onPointerEnd);
  applyGyroOption(opts.gyro);

  return {
    look,

    setOptions(o) {
      if (disposed) return;
      if (o.mode !== mode) {
        mode = o.mode;
        endDrag();
      }
      applyGyroOption(o.gyro);
    },

    recenter(toward, durationSec = CAMERA.recenterSec) {
      if (disposed) return;
      const toYaw = clamp(toward?.yaw ?? 0, -YAW_MAX, YAW_MAX);
      const toPitch = clamp(toward?.pitch ?? 0, -PITCH_MAX, PITCH_MAX);
      if (!(durationSec > 0)) {
        recenter = null;
        base.yaw = toYaw - gyro.yaw;
        base.pitch = toPitch - gyro.pitch;
        settleBase();
        look.yaw = toYaw;
        look.pitch = toPitch;
        return;
      }
      recenter = { fromYaw: look.yaw, fromPitch: look.pitch, toYaw, toPitch, duration: durationSec, elapsed: 0 };
    },

    update(dt) {
      if (disposed) return;
      if (recenter) {
        recenter.elapsed += dt;
        const done = recenter.elapsed >= recenter.duration;
        const s = done ? 1 : easeGlass(recenter.elapsed / recenter.duration);
        const yaw = lerp(recenter.fromYaw, recenter.toYaw, s);
        const pitch = lerp(recenter.fromPitch, recenter.toPitch, s);
        // 曲線そのものが滑らかなので damp は通さない。傾きは差し引いて base に持ち、終わったらいまの端末の向きを正面にする
        base.yaw = yaw - gyro.yaw;
        base.pitch = pitch - gyro.pitch;
        look.yaw = yaw;
        look.pitch = pitch;
        if (done) {
          recenter = null;
          if (gyroOn) rebaseGyro();
        }
        return;
      }
      const targetYaw = clamp(base.yaw + gyro.yaw, -YAW_MAX, YAW_MAX);
      const targetPitch = clamp(base.pitch + gyro.pitch, -PITCH_MAX, PITCH_MAX);
      const halfLife = mode === 'follow' ? FOLLOW_HALF_LIFE : DRAG_HALF_LIFE;
      look.yaw = damp(look.yaw, targetYaw, halfLife, dt);
      look.pitch = damp(look.pitch, targetPitch, halfLife, dt);
    },

    setEnabled(on) {
      if (disposed) return;
      enabled = on;
      if (!on) endDrag();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      enabled = false;
      endDrag();
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerEnd);
      el.removeEventListener('pointercancel', onPointerEnd);
      el.removeEventListener('lostpointercapture', onPointerEnd);
      window.removeEventListener('deviceorientation', onOrientation);
      el.style.touchAction = prevTouchAction;
    },
  };
}
