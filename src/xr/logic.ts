// VR の純粋な計算。three.js の描画器にも WebXR にも触れない（単体テストで確かめる）。
// 向きは three.js の rotation.y と同じ（-Z 方向が 0、左回りが正）。
import type { Vec3Tuple } from '../contracts/events';
import type { XRPosture } from '../contracts/ids';
import type { Touchable } from '../contracts/room';
import { CAMERA, INTERACTION, MOTION, TRANSITION_SEC, UI, XR } from '../config';
import { smoothstep, wrapAngle } from '../core/easing';
import { XR_TUNING } from './tuning';

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

// ── 座る / 立つ ──────────────────────────────────────────────────

/** 座って乗るなら床を持たない local、立って乗るなら床からの高さが分かる local-floor */
export function referenceSpaceFor(posture: XRPosture): 'local' | 'local-floor' {
  return posture === 'standing' ? 'local-floor' : 'local';
}

/**
 * 台の高さ。頭の高さ（基準空間での目の高さ）から、目が座席の目の高さ（ゴンドラの中心から
 * CAMERA.seatEyeHeight）に来るよう台を上下させる量。頭の高さが分からなければ、座るなら 0、立つなら 1.6m とみなす。
 */
export function rigHeightOffset(posture: XRPosture, headHeight: number | null): number {
  const head = headHeight ?? (posture === 'standing' ? XR_TUNING.standingEyeHeight : 0);
  return CAMERA.seatEyeHeight - head;
}

/** 正面の合わせ直し: 頭の向きを打ち消す台の向き（-π〜π） */
export function recenterYaw(headYaw: number): number {
  return wrapAngle(-headYaw);
}

/** 向き（クォータニオン）から左右の向き。真上や真下を向いても、体の傾きに強い方の軸で決める */
export function yawFromQuaternion(x: number, y: number, z: number, w: number): number {
  // 回転行列の第3列（後ろ向き +Z の行き先）と第1列（右 +X の行き先）の水平成分
  const bx = 2 * (x * z + w * y);
  const bz = 1 - 2 * (x * x + y * y);
  const rx = 1 - 2 * (y * y + z * z);
  const rz = 2 * (x * z - w * y);
  // 前を向いている（後ろ向きの軸が水平に近い）なら +Z から、大きく傾いているなら +X から
  if (bx * bx + bz * bz >= rx * rx + rz * rz) return Math.atan2(bx, bz);
  return Math.atan2(-rz, rx);
}

// ── 指先で触れる ────────────────────────────────────────────────

export interface FingertipHit {
  readonly touchable: Touchable;
  /** 何番目の指先か（渡した配列の番号） */
  readonly tip: number;
  /** 触れた点（ワールド座標）。指先の位置 */
  readonly point: Vec3Tuple;
}

export interface Nearest {
  /** 一覧の番号。いなければ -1 */
  index: number;
  /** 表面までの距離（m）。中に入っていれば負 */
  distance: number;
}

/**
 * 点から、表面までの距離が reach 以内の有効な物のうち最も近いものを探す（毎フレーム使うので確保しない）。
 * 物の中心は object のワールド行列（前のフレームの描画で更新済み）から読む。
 */
export function nearestTouchable(x: number, y: number, z: number, list: readonly Touchable[], reach: number, out: Nearest): boolean {
  out.index = -1;
  out.distance = Infinity;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t.enabled) continue;
    const e = t.object.matrixWorld.elements;
    const dx = x - e[12];
    const dy = y - e[13];
    const dz = z - e[14];
    const limit = t.radius + reach;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > limit * limit) continue;
    const d = Math.sqrt(d2) - t.radius;
    if (d < out.distance) {
      out.distance = d;
      out.index = i;
    }
  }
  return out.index >= 0;
}

/** 指先ごとに、表面までの距離が INTERACTION.xrTouchDistance 以内の有効な物のうち最も近い1つ */
export function fingertipHits(tips: readonly Vec3Tuple[], list: readonly Touchable[]): FingertipHit[] {
  const hits: FingertipHit[] = [];
  const near: Nearest = { index: -1, distance: Infinity };
  for (let k = 0; k < tips.length; k++) {
    const tip = tips[k];
    if (nearestTouchable(tip[0], tip[1], tip[2], list, INTERACTION.xrTouchDistance, near)) {
      hits.push({ touchable: list[near.index], tip: k, point: tip });
    }
  }
  return hits;
}

/** 光線が通る物の候補（手前から数個）。表面の確かめは呼び出し側が Raycaster で行う */
export interface RayCandidates {
  count: number;
  /** 一覧の番号（手前から） */
  readonly index: number[];
  /** 光線に沿った、物の中心までの距離（m） */
  readonly along: number[];
}

export function createRayCandidates(capacity: number): RayCandidates {
  return { count: 0, index: new Array<number>(capacity).fill(-1), along: new Array<number>(capacity).fill(Infinity) };
}

/**
 * 光線（origin と単位ベクトルの dir）が通る有効な物のうち、表面までの距離が maxSurface 以内のものを、手前から
 * out の容量まで集める（毎フレーム使うので確保しない）。当たりは、物の原点を中心にした半径 radius の球に、
 * 距離に比例する余裕（slackDeg）を足したもので見る。これは前段の絞り込みで、表面の点は Raycaster で取る。
 */
export function rayCandidates(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  list: readonly Touchable[],
  slackDeg: number,
  maxSurface: number,
  out: RayCandidates,
): number {
  out.count = 0;
  const cap = out.index.length;
  const slack = Math.tan((slackDeg * Math.PI) / 180);
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t.enabled) continue;
    const e = t.object.matrixWorld.elements;
    const vx = e[12] - ox;
    const vy = e[13] - oy;
    const vz = e[14] - oz;
    const along = vx * dx + vy * dy + vz * dz;
    if (along <= 0.05 || along - t.radius > maxSurface) continue;
    const perp2 = vx * vx + vy * vy + vz * vz - along * along;
    const tol = t.radius + along * slack;
    if (perp2 > tol * tol) continue;
    let k: number;
    if (out.count < cap) {
      k = out.count;
      out.count++;
    } else if (along < out.along[cap - 1]) {
      k = cap - 1;
    } else {
      continue;
    }
    while (k > 0 && out.along[k - 1] > along) {
      out.index[k] = out.index[k - 1];
      out.along[k] = out.along[k - 1];
      k--;
    }
    out.index[k] = i;
    out.along[k] = along;
  }
  return out.count;
}

// ── 移動中の外周の暗さ ──────────────────────────────────────────

/**
 * 外周の暗さ（0〜setting）。止まっていれば 0。速さと回転が上限に近づくほど強まり、setting を超えない。
 * 速さ（m/s）は前進の上限 MOTION.speedMax、回転（度/秒）は MOTION.yawRateMaxDeg を 1 とする。
 */
export function vignetteFor(speed: number, yawRateDeg: number, setting: number): number {
  const s = clamp01(Math.abs(speed) / MOTION.speedMax);
  const y = clamp01(Math.abs(yawRateDeg) / MOTION.yawRateMaxDeg);
  // 足し算だと 1 を超えるので、どちらかが上限なら 1 になる「重ね」にする
  const amount = 1 - (1 - s) * (1 - y);
  return clamp01(setting) * amount;
}

// ── メニュー ───────────────────────────────────────────────────

export interface MenuPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * 曇りガラスのメニューの置き場所（板の中心）。頭の前方 XR.menuDistance、目より少し下、頭の方を向く。
 * 向き（yaw）は three.js の rotation.y。板の表（+Z）が頭を向くよう、頭の向きと同じ yaw にする。
 * 背の高い板で下端が下がりすぎる分の調整は、板の大きさを知っている呼び出し側が行う。
 */
export function menuPose(head: MenuPose): MenuPose {
  return {
    x: head.x - Math.sin(head.yaw) * XR.menuDistance,
    y: head.y - XR_TUNING.menuDrop,
    z: head.z - Math.cos(head.yaw) * XR.menuDistance,
    yaw: head.yaw,
  };
}

/**
 * メニューの文字の高さ（m）。画面版の最小の文字（UI.minFontPx、1080p で縦の視野 CAMERA.fovDeg）の
 * 視角を XR.textScale 倍にして、メニューの距離で物差しに直す。
 */
export function menuTextHeight(): number {
  const screenDeg = (UI.minFontPx / 1080) * CAMERA.fovDeg;
  return XR.menuDistance * Math.tan(((screenDeg * XR.textScale) * Math.PI) / 180);
}

// ── 画面 → VR の白い霧 ─────────────────────────────────────────

/**
 * 白い霧の不透明度。セッションが始まり、頭の高さと正面を合わせ終えたときを 0 秒として、1 で始まり
 * TRANSITION_SEC.screenToVR（1.0秒）かけて晴れる（合わせ終えるまでは晴らさない）。
 * 霧は経過時間で決める（フレームの積み上げで状態を作らない）。
 */
export function whiteoutOpacity(sinceStartSec: number): number {
  return 1 - smoothstep(0, TRANSITION_SEC.screenToVR, sinceStartSec);
}
