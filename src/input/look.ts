// 見回し（CAM-1 / CAM-2 / INT-5）。カメラはゴンドラの座席に固定し、向き（yaw・pitch）だけを作る。
// yaw は左向きが正、pitch は上向きが正（three の Euler 'YXZ' にそのまま入れられる）。
//
// 向きは 3 つの足し合わせで決める:
//   base … ドラッグの積算、または追従モードのマウス位置、または「正面へ戻す」の途中経過
//   gyro … 端末の傾き（最初の向きからの差。巻き戻らない連続した値）
//   look = 範囲に収めた (base + gyro) へ、damp で寄せたもの
// 範囲を超えた分は、ドラッグなら base に、傾きなら傾きの基準に吸わせる（戻したとき、すぐ動くように）。
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
/** 追従モードで、戻している間にマウスがこれ以上（要素の半幅を 1 とした距離）動いたら、戻しを打ち切ってマウスに任せる */
const FOLLOW_CANCEL_NORM = 0.25;
/** 追従モードで正面へ戻した後、マウスがこれだけ動くまでに「戻した向きとマウスの向きの差」を使い切る（それまでは差を保つ） */
const FOLLOW_RELEASE_NORM = 0.5;
/** 要素の高さが取れないときの代わり */
const FALLBACK_HEIGHT = 600;
/** 傾きの前向きベクトルが垂直に近いとき、yaw は定まらないので前の値を保つ */
const GYRO_VERTICAL_EPS = 0.2;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * easeGlass の最大の傾き（1 秒かけたときの、最も速い瞬間の「進む割合/秒」）。
 * 戻しの最大の角速度を CAMERA.recenterMaxDegPerSec 以下にするために、長さの下限を出すのに使う。
 */
const EASE_MAX_SLOPE = (() => {
  const n = 512;
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, (easeGlass((i + 1) / n) - easeGlass(i / n)) * n);
  return m * 1.01; // 差分で測るので少し余裕を見る
})();

/** 設定の視野角（度）を、感度に使うラジアンにする。範囲外や不正な値は既定に戻す */
function fovRadians(deg: number | undefined): number {
  return clamp(isNum(deg) ? deg : CAMERA.fovDeg, CAMERA.fovMinDeg, CAMERA.fovMaxDeg) * DEG;
}

/** 追従モードの曲線。n は -1〜1（要素の中心からの位置）。戻り値も -1〜1 */
function followShape(n: number): number {
  const a = clamp((Math.abs(n) - FOLLOW_DEAD_ZONE) / (FOLLOW_EDGE - FOLLOW_DEAD_ZONE), 0, 1);
  return Math.sign(n) * Math.pow(a, FOLLOW_CURVE);
}

/** 追従モードで、マウスの位置（要素の中心を 0、端を ±1）から決まる向き。右 → 右を向く（yaw は負）、上 → 上を向く */
const followYaw = (nx: number) => -followShape(nx) * YAW_MAX;
const followPitch = (ny: number) => -followShape(ny) * PITCH_MAX;

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
  let fov = fovRadians(opts.fovDeg);
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

  // ── 追従モード ──
  /** 最後に見たマウスの位置（要素の中心を 0、端を ±1） */
  const mouse = { x: 0, y: 0, known: false };
  /** 戻し始めたときのマウスの位置 */
  const rcRef = { x: 0, y: 0, known: false };
  /** 戻した向き − そのときのマウスから決まる向き。マウスが動くにつれて縮め、振り戻しを防ぐ */
  const followOff = { yaw: 0, pitch: 0 };
  /** 戻し終えたときのマウスの位置と、そこからの最大の移動量 */
  const followRef = { x: 0, y: 0, known: false, moved: 0 };

  // ── 端末の傾き ──
  /** 端末の向きの yaw を、±180° で折り返さない連続した値にしたもの（最初の読みが 0） */
  let devYaw = 0;
  let devPitch = 0;
  /** 傾きの基準。gyro = dev − devBase。範囲を超えた分はここに足して吸う */
  const devBase = { yaw: 0, pitch: 0 };
  const devTmp = { yaw: 0, pitch: 0 };
  let lastRawYaw = 0;
  let hasYaw = false;
  let hasDev = false;
  /** ポーズから戻ったとき、次の読みで基準を取り直す（再開の瞬間に振れない） */
  let gyroResync = false;

  const elementHeight = () => {
    const h = el.getBoundingClientRect().height || el.clientHeight;
    return h > 0 ? h : FALLBACK_HEIGHT;
  };

  /** 1px のドラッグが何ラジアンか。画面の中央で、指に景色が 1:1 で付いてくる量 */
  const radPerPx = () => (2 * Math.tan(fov / 2)) / elementHeight();

  /** (base + gyro) を範囲に収め、はみ出した分は base に残さない（ドラッグを戻したとき即座に動くように） */
  function settleBase() {
    base.yaw = clamp(base.yaw + gyro.yaw, -YAW_MAX, YAW_MAX) - gyro.yaw;
    base.pitch = clamp(base.pitch + gyro.pitch, -PITCH_MAX, PITCH_MAX) - gyro.pitch;
  }

  /** 傾きで範囲を超えた分を、傾きの基準に吸わせる（体を回し続けても範囲の端で止まり、戻せばすぐ動く） */
  function absorbGyroOver() {
    if (recenter) return; // 戻している間は base が向きを持つ
    const ty = base.yaw + gyro.yaw;
    const oy = ty - clamp(ty, -YAW_MAX, YAW_MAX);
    if (oy !== 0) {
      devBase.yaw += oy;
      gyro.yaw -= oy;
    }
    const tp = base.pitch + gyro.pitch;
    const op = tp - clamp(tp, -PITCH_MAX, PITCH_MAX);
    if (op !== 0) {
      devBase.pitch += op;
      gyro.pitch -= op;
    }
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
    followOff.yaw = 0;
    followOff.pitch = 0;
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
    if (dragId === null && followsPointer(e)) followPointer(e);
  }

  /** 追従モード: マウスの位置から向きを決める */
  function followPointer(e: PointerEvent) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    mouse.x = nx;
    mouse.y = ny;
    mouse.known = true;

    if (recenter) {
      // 戻している間は、マウスが置いてあるだけの揺れでは止めない。大きく動かしたら戻しを打ち切ってマウスに任せる
      if (!rcRef.known) {
        rcRef.x = nx;
        rcRef.y = ny;
        rcRef.known = true;
        return;
      }
      if (Math.hypot(nx - rcRef.x, ny - rcRef.y) < FOLLOW_CANCEL_NORM) return;
      recenter = null;
      followOff.yaw = 0;
      followOff.pitch = 0;
    }

    // 戻した直後は「戻した向き」を保ち、マウスが動いた量に応じて、マウスの向きとの差を縮める
    // （1px 動いただけで、元の向きへ振り戻らないように。縮めたものは戻さない）
    if (!followRef.known) {
      followRef.x = nx;
      followRef.y = ny;
      followRef.known = true;
    }
    followRef.moved = Math.max(followRef.moved, Math.hypot(nx - followRef.x, ny - followRef.y));
    const keep = 1 - clamp(followRef.moved / FOLLOW_RELEASE_NORM, 0, 1);
    base.yaw = followYaw(nx) + followOff.yaw * keep;
    base.pitch = followPitch(ny) + followOff.pitch * keep;
    settleBase();
  }

  function onPointerEnd(e: PointerEvent) {
    endDrag(e);
  }

  // ── 端末の傾き ──
  function onOrientation(e: Event) {
    if (!enabled || !gyroOn) return;
    const { alpha, beta, gamma } = e as Event & { alpha?: unknown; beta?: unknown; gamma?: unknown };
    // センサーのない PC は値なしで 1 度だけ送り、壊れた値（NaN）が来ると向きが NaN のまま戻らなくなる
    if (!isNum(alpha) || !isNum(beta) || !isNum(gamma)) return;
    const fresh = !hasDev || gyroResync;
    if (viewDirection(alpha, beta, gamma, devTmp)) {
      if (hasYaw && !fresh) devYaw += wrapAngle(devTmp.yaw - lastRawYaw);
      lastRawYaw = devTmp.yaw;
      hasYaw = true;
    }
    devPitch = devTmp.pitch;
    hasDev = true;
    if (fresh) {
      // 最初の向き（またはポーズから戻った向き）を正面にする。見た目は動かさない
      if (gyroResync) {
        base.yaw += gyro.yaw;
        base.pitch += gyro.pitch;
      }
      gyro.yaw = 0;
      gyro.pitch = 0;
      if (gyroResync) settleBase();
      devBase.yaw = devYaw;
      devBase.pitch = devPitch;
      gyroResync = false;
      return;
    }
    gyro.yaw = devYaw - devBase.yaw;
    gyro.pitch = devPitch - devBase.pitch;
    absorbGyroOver();
  }

  /** 傾きの基準を「いまの向き」に取り直し、見た目の向きは変えない（差を base に移す） */
  function rebaseGyro() {
    base.yaw += gyro.yaw;
    base.pitch += gyro.pitch;
    gyro.yaw = 0;
    gyro.pitch = 0;
    if (hasDev) {
      devBase.yaw = devYaw;
      devBase.pitch = devPitch;
    }
    settleBase();
  }

  function applyGyroOption(on: boolean) {
    if (on === gyroOn) return;
    gyroOn = on;
    if (on) {
      hasDev = false;
      hasYaw = false;
      gyroResync = false;
      devYaw = 0;
      devPitch = 0;
      devBase.yaw = 0;
      devBase.pitch = 0;
      window.addEventListener('deviceorientation', onOrientation);
    } else {
      window.removeEventListener('deviceorientation', onOrientation);
      rebaseGyro(); // 切ったときに視界が跳ねないよう、いまの向きを base に残す
      hasDev = false;
      hasYaw = false;
      gyroResync = false;
    }
  }

  /** 戻し終えた（または即座に向けた）後の仕上げ: 傾きと、追従モードのマウスの基準を取り直す */
  function finishRecenter(toYaw: number, toPitch: number) {
    if (gyroOn) rebaseGyro();
    if (mode === 'follow') {
      followOff.yaw = toYaw - followYaw(mouse.x);
      followOff.pitch = toPitch - followPitch(mouse.y);
      followRef.x = mouse.x;
      followRef.y = mouse.y;
      followRef.known = mouse.known;
      followRef.moved = 0;
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
      fov = fovRadians(o.fovDeg);
      if (o.mode !== mode) {
        mode = o.mode;
        endDrag();
        followOff.yaw = 0;
        followOff.pitch = 0;
      }
      applyGyroOption(o.gyro);
    },

    recenter(toward, durationSec = CAMERA.recenterSec) {
      if (disposed) return;
      const toYaw = clamp(isNum(toward?.yaw) ? toward.yaw : 0, -YAW_MAX, YAW_MAX);
      const toPitch = clamp(isNum(toward?.pitch) ? toward.pitch : 0, -PITCH_MAX, PITCH_MAX);
      if (!(durationSec > 0)) {
        recenter = null;
        base.yaw = toYaw - gyro.yaw;
        base.pitch = toPitch - gyro.pitch;
        settleBase();
        look.yaw = toYaw;
        look.pitch = toPitch;
        finishRecenter(toYaw, toPitch);
        return;
      }
      // 大きく外れているときは、指定の秒より長くかけて、最も速い瞬間でも最大の角速度を超えないようにする（酔わせない）
      const distDeg = Math.hypot(toYaw - look.yaw, toPitch - look.pitch) / DEG;
      const duration = Math.max(durationSec, (distDeg * EASE_MAX_SLOPE) / CAMERA.recenterMaxDegPerSec);
      recenter = { fromYaw: look.yaw, fromPitch: look.pitch, toYaw, toPitch, duration, elapsed: 0 };
      rcRef.x = mouse.x;
      rcRef.y = mouse.y;
      rcRef.known = mouse.known;
    },

    update(dt) {
      if (disposed) return;
      if (recenter) {
        recenter.elapsed += dt;
        const done = recenter.elapsed >= recenter.duration;
        const s = done ? 1 : easeGlass(recenter.elapsed / recenter.duration);
        const yaw = lerp(recenter.fromYaw, recenter.toYaw, s);
        const pitch = lerp(recenter.fromPitch, recenter.toPitch, s);
        // 曲線そのものが滑らかなので damp は通さない。傾きは差し引いて base に持つ
        base.yaw = yaw - gyro.yaw;
        base.pitch = pitch - gyro.pitch;
        look.yaw = yaw;
        look.pitch = pitch;
        if (done) {
          const { toYaw, toPitch } = recenter;
          recenter = null;
          finishRecenter(toYaw, toPitch);
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
      if (on && !enabled && gyroOn) gyroResync = true; // 止めている間に端末が動いていても、再開の瞬間に振れない
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
