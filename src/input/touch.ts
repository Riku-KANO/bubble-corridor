// 触れる入力（INT-1 / INT-2 / INT-4）。クリック・タップ・見つめるを、光線と触れられる物の交差で受ける。
// 触れた反応は、その出来事の中で同期的に onTouch を呼ぶ（0.1 秒以内の約束を、描画を待たずに守る）。
// 毎フレームの確保を避けるため、作業用のベクトル・配列・光線は使い回す。
import { Raycaster, Vector2, Vector3 } from 'three/webgpu';
import type { Camera, Object3D } from 'three';
import { INTERACTION } from '../config';
import type { EventBus, Vec3Tuple } from '../contracts/events';
import type { InputDeps, TouchInput } from '../contracts/input';
import type { Touchable } from '../contracts/room';
import { smoothstep } from '../core/easing';

// ── 手触りの数（設計書に値がないので仮。config に足す候補として報告する） ──
/** 押してから離すまでにこの距離（px）以上動いたらドラッグ（見回し）で、触れたことにしない */
const TAP_SLOP_PX = 8;
/** 乗車の秒がこれ以上戻ったら、新しい乗車（または巻き戻し）とみなして触れた記録を捨てる */
const REWIND_SEC = 0.5;
/** 1 フレームの長さの上限。タブを裏にした後の 1 フレームで、見つめた時間が一気にたまらないように */
const MAX_DT = 0.25;
/** setHighlight を呼び直す最小の変化量（毎フレーム呼ばないため） */
const HIGHLIGHT_STEP = 0.005;
/** 見つめている物から視線が外れても、この秒数までは数え直さない（手の震えや傾きのゆらぎで途切れないように） */
const GAZE_GRACE_SEC = 0.15;

/** 触れられる物 1 つぶんの、入力側で覚えておく状態 */
interface Entry {
  readonly t: Touchable;
  /** 最後に setHighlight した値 */
  level: number;
  /** 見つめて触れられる距離（gazeMaxDistance、物の表面まで）にあるか。update で毎フレーム決める */
  gazeable: boolean;
  touched: boolean;
  chimed: boolean;
  /** 最後に触れた乗車の秒 */
  lastTouchAt: number;
  /** この世代と違えば、触れた記録は前の乗車のもの */
  epoch: number;
}

/** 自分か祖先が見えない状態（部屋ごと隠れている）なら false */
function isVisible(obj: Object3D): boolean {
  for (let o: Object3D | null = obj; o; o = o.parent) if (!o.visible) return false;
  return true;
}

export function createTouchInput(deps: InputDeps): TouchInput {
  const el = deps.element;
  const events: EventBus = deps.events;

  let enabled = false;
  let disposed = false;
  let entries: Entry[] = [];
  /** 部屋の切り替えで一覧が差し替わっても、同じ物の記録（触れた・鳴った）を引き継ぐ */
  const states = new WeakMap<Touchable, Entry>();
  let epoch = 0;
  let lastT = -Infinity;
  let camera: Camera | null = null;
  let idleHandler: ((t: Touchable) => void) | null = null;
  let dwellSec: number = INTERACTION.gazeDwellSec;

  // ── 作業用（使い回す） ──
  const raycaster = new Raycaster();
  raycaster.layers.enableAll(); // 触れられる物がどのレイヤーにいても当てる
  const ndc = new Vector2();
  const center = new Vector2(0, 0);
  const hits: ReturnType<Raycaster['intersectObject']> = [];
  const hitPoint = new Vector3();

  // ── 見つめる ──
  let gazeEntry: Entry | null = null;
  let gazeTime = 0;
  let gazeFired = false;
  /** 見つめていた物から視線が外れている時間 */
  let gazeAway = 0;

  // ── 押している指（またはマウス） ──
  let press: { id: number; x: number; y: number; moved: boolean } | null = null;

  const entryFresh = (e: Entry) => {
    if (e.epoch !== epoch) {
      e.epoch = epoch;
      e.touched = false;
      e.chimed = false;
      e.lastTouchAt = -Infinity;
    }
  };

  /**
   * 設定済みの光線で、有効な物のうち最も手前の物を探す（見つかった点は hitPoint に入る）。
   * onlyNear のときは、見つめて触れられる距離にある物だけに当てる（見つめるは毎フレーム呼ぶので先に絞る）。
   */
  function pick(onlyNear: boolean): Entry | null {
    let best: Entry | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e.t.enabled) continue;
      if (onlyNear && !e.gazeable) continue;
      if (!isVisible(e.t.object)) continue;
      hits.length = 0;
      raycaster.intersectObject(e.t.object, true, hits);
      if (hits.length > 0 && hits[0].distance < bestDist) {
        bestDist = hits[0].distance;
        best = e;
        hitPoint.copy(hits[0].point);
      }
    }
    hits.length = 0;
    return best;
  }

  /** 触れる。反応を（同期で）返し、touch を出す。同じ物は retriggerSec の間は再び鳴らさない */
  function fire(e: Entry, source: 'pointer' | 'gaze', point: Vector3) {
    entryFresh(e);
    const now = deps.now();
    const since = now - e.lastTouchAt;
    // 時刻が戻った（新しい乗車）ときの since は負なので、間引かない
    if (since >= 0 && since < INTERACTION.retriggerSec) return;
    e.lastTouchAt = now;
    e.touched = true;
    const position: Vec3Tuple = [point.x, point.y, point.z];
    try {
      e.t.onTouch({ t: now, source, point: position });
    } finally {
      // 部屋の反応が例外を出しても、音の担当には必ず届ける
      events.emit('touch', { touchableId: e.t.id, kind: e.t.kind, section: e.t.section, position, source, t: now });
    }
  }

  // ── ポインター ──
  function onPointerDown(ev: PointerEvent) {
    if (!enabled || ev.button !== 0) return;
    // 同じ id のまま押し直された（離した合図を取りこぼした）なら、古い押下は捨てて数え直す
    if (press && press.id !== ev.pointerId) {
      press.moved = true; // 2 本目の指が来たら、つまむ・回すなどの操作であって触れたのではない
      return;
    }
    press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: false };
    try {
      // 要素の外で離しても pointerup（または pointercancel）を必ず受け取り、押下の記録が残り続けないようにする
      el.setPointerCapture?.(ev.pointerId);
    } catch {
      // 合成イベントなどで捕捉できなくても、要素の上のタップは動く
    }
  }

  function onPointerMove(ev: PointerEvent) {
    if (!press || ev.pointerId !== press.id || press.moved) return;
    if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) >= TAP_SLOP_PX) press.moved = true;
  }

  function onPointerUp(ev: PointerEvent) {
    if (!press || ev.pointerId !== press.id) return;
    const p = press;
    press = null;
    if (!enabled || p.moved || !camera) return;
    if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) >= TAP_SLOP_PX) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -(((ev.clientY - rect.top) / rect.height) * 2 - 1));
    raycaster.setFromCamera(ndc, camera);
    const hit = pick(false);
    if (hit) fire(hit, 'pointer', hitPoint);
  }

  function onPointerCancel(ev: PointerEvent) {
    if (press && ev.pointerId === press.id) press = null;
  }

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerCancel);
  el.addEventListener('lostpointercapture', onPointerCancel);

  function resetGaze() {
    gazeEntry = null;
    gazeTime = 0;
    gazeFired = false;
    gazeAway = 0;
  }

  // 新しい乗車の区切り。update の時刻の巻き戻しでも気づくが、乗車が終わった時点で確実に捨てる
  const offRideEnd = events.on('rideEnd', () => {
    epoch++;
    lastT = -Infinity;
    resetGaze();
  });

  return {
    setTouchables(list) {
      if (disposed) return;
      const next: Entry[] = [];
      for (const t of list) {
        let e = states.get(t);
        if (!e) {
          e = { t, level: 0, gazeable: false, touched: false, chimed: false, lastTouchAt: -Infinity, epoch };
          states.set(t, e);
        }
        // 最初の update（描画より前）でも距離が正しく出るよう、いまの位置を matrixWorld に反映しておく
        t.object.updateWorldMatrix(true, false);
        next.push(e);
      }
      entries = next;
      // 見つめていた物が一覧から消えたら数え直す
      if (gazeEntry && !next.includes(gazeEntry)) resetGaze();
    },

    setGazeDwell(sec) {
      if (Number.isFinite(sec) && sec > 0) dwellSec = sec;
    },

    update(t, dt, cam, gondola) {
      if (disposed || !enabled) return;
      camera = cam;
      // 新しい乗車（または巻き戻し）。触れた・鳴った記録は前の乗車のものなので捨てる
      if (t < lastT - REWIND_SEC) {
        epoch++;
        resetGaze();
      }
      lastT = t;

      const gx = gondola[0];
      const gy = gondola[1];
      const gz = gondola[2];
      const hd = INTERACTION.highlightDistance;
      const cd = INTERACTION.idleChimeDistance;
      const gd = INTERACTION.gazeMaxDistance;
      let anyGazeable = false;

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        entryFresh(e);
        const te = e.t;
        // 物の原点（ワールド）から物の表面までの距離。matrixWorld は直近の描画で更新済み
        const m = te.object.matrixWorld.elements;
        const dx = m[12] - gx;
        const dy = m[13] - gy;
        const dz = m[14] - gz;
        const d = Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - te.radius);
        // 無効な物、祖先ごと見えない物は、光らせず・鳴らさず・見つめても触れない。見えるかどうかは、関わる距離のときだけ調べる
        let live = te.enabled;
        if (live && (d < gd || e.level !== 0)) live = isVisible(te.object);

        e.gazeable = live && d <= gd;
        if (e.gazeable) anyGazeable = true;
        // 縁の光: 近いほど強く、遠い端ではかすかに
        const level = live && d < hd ? 1 - smoothstep(0, hd, d) : 0;
        if (Math.abs(level - e.level) >= HIGHLIGHT_STEP || (level === 0 && e.level !== 0)) {
          e.level = level;
          te.setHighlight(level);
        }

        // 触れられないまま近づいた物は、一度だけ自分で鳴る
        if (live && te.idleChime && !e.touched && !e.chimed && d < cd) {
          e.chimed = true;
          idleHandler?.(te);
        }
      }

      // 見つめて触れる: 画面の中央の光線で当たる、見つめて触れられる距離の有効な物にだけ時間をためる
      let target: Entry | null = null;
      if (anyGazeable) {
        raycaster.setFromCamera(center, cam);
        target = pick(true);
      }
      const step = Math.min(Math.max(dt, 0), MAX_DT);
      if (target !== null && target === gazeEntry) {
        gazeAway = 0;
        gazeTime += step;
      } else if (target === null && gazeEntry !== null && gazeAway + step < GAZE_GRACE_SEC) {
        gazeAway += step; // 視線が少し外れただけ。時間は保ったまま、外れている間は進めない
      } else {
        gazeEntry = target;
        gazeTime = target ? step : 0;
        gazeFired = false;
        gazeAway = 0;
      }
      if (gazeEntry && target === gazeEntry && !gazeFired && gazeTime >= dwellSec) {
        gazeFired = true; // 見つめ続けても繰り返さない。外れて戻れば再び触れる
        fire(gazeEntry, 'gaze', hitPoint);
      }
    },

    onIdleChime(fn) {
      idleHandler = fn;
    },

    setEnabled(on) {
      if (disposed) return;
      enabled = on;
      if (!on) {
        press = null;
        resetGaze();
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      enabled = false;
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerCancel);
      el.removeEventListener('lostpointercapture', onPointerCancel);
      offRideEnd();
      entries = [];
      press = null;
      camera = null;
      idleHandler = null;
      resetGaze();
    },
  };
}
