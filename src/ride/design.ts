// レールと時刻表の設計（Blender のプレビズの代わりにコードで作る。ADR-0002）。
//
// 流れ（時刻から決める）:
//   1. レールの水平の形を「進んで曲がる」の列で決める。曲がり始めと終わりは曲率を滑らかに変える（向きの回転が急に始まらない）。
//      輪を閉じる（降車の終点が乗り場の始点）ために、2か所の直線の長さだけを連立方程式で解く。
//   2. 高さは脚（区間、天球だけ中心の前後で2つ）の中の進み具合 u（0〜1）の鍵で決める。鍵の間は cosine でつなぐ。
//      点は3Dで等間隔に打ち、s は3Dの弧長（ADR-0008）。
//   3. 速度の設計は脚ごとの「時刻の範囲と速さの水平な保持」の並び。保持の間は cosine で加減速する。
//      普段の速さ c だけ未知で、脚の3Dの長さ = 速度の積分、となるように解く。上限は config の MOTION（漂う速さ）。
//   4. 時刻表（t → s）は速度の積分から 0.25 秒刻みで作る。
//
// レールは1本（ADR-0008）。穏やかモードも同じ道筋で、標準の動きそのものを穏やかの上限（上下 0.3 m/s、回転 7.5°/s）以内に設計する。
// 部屋の形はこのレールの点（ride.pointAt）を基準に置く。形の要点は dev/ride.html の地図と describeDesign の目印で見る。
import { GONDOLA_DIAMETER, MOMENT_BARS, MOTION, RIDE_DURATION, SEC_PER_BAR, SECTIONS } from '../config';
import type { Vec3Tuple, CueName } from '../contracts/events';
import type { SectionId } from '../contracts/ids';
import type { RideData } from '../contracts/ride';
import { createRide } from './rail';

const DEG = Math.PI / 180;

/** 時刻表の細かさ（秒）。createRide が点の間を滑らかに補う */
const TIMELINE_DT = 0.25;
/** 加速度の設計の上限（m/s²）。テストの 0.12 に余裕を残す。cosine の加減速の山 = |Δv|·π/(2·時間) */
const ACCEL_DESIGN_MAX = 0.11;

// ── 時刻の基準（config の小節から） ───────────────────────────────
const startT = (id: SectionId) => SECTIONS.find((s) => s.id === id)!.startBar * SEC_PER_BAR;
const T = {
  platform: startT('platform'),
  greenhouse: startT('greenhouse'),
  rain: startT('rain'),
  kaleidoscope: startT('kaleidoscope'),
  celestial: startT('celestial'),
  dawn: startT('dawn'),
  departure: startT('departure'),
  end: RIDE_DURATION,
} as const;
const AT = {
  bloom: MOMENT_BARS.greenhouseBloom * SEC_PER_BAR,
  freeze: MOMENT_BARS.rainFreeze * SEC_PER_BAR,
  flower: MOMENT_BARS.kaleidoscopeFlower * SEC_PER_BAR,
  constellation: MOMENT_BARS.celestialConstellation * SEC_PER_BAR,
  sunrise: MOMENT_BARS.dawnSunrise * SEC_PER_BAR,
} as const;

// ── 速度の設計（m/s）。数値は config の MOTION ───────────────────────
const V_MEMBRANE = MOTION.membraneSpeed;
const V_HIGHLIGHT = MOTION.highlightSpeed;
const V_DOORS = MOTION.doorsSpeed;
/** 大きな速さの変化にかける秒数（漂う感じを保つ）と、小さな変化（0.35 m/s ほど）にかける秒数 */
const RAMP = MOTION.driftRampSec;
const RAMP_SMALL = Math.round(MOTION.driftRampSec * 0.75);
/** 部屋に入った直後、膜の前後の遅い速さを保つ秒数 */
const ENTRY_HOLD = 8;
/** 見どころの前後で遅い速さを保つ秒数（見どころの時刻の前 / 後） */
const HOLD_BEFORE = 4;
const HOLD_AFTER = 8;
/** 雨粒が止まった後、止まった雨粒の間をすり抜けていく間は遅いまま保つ秒数 */
const HOLD_AFTER_FREEZE = 14;

/** 速さの水準。'c' は普段の速さ（未知、脚ごとに解く）、'a' は見どころの後の普段の速さ（c と afterHighlightMax の小さい方） */
type Level = number | 'c' | 'a';
/** 速さの保持: from から to まで水準 v を保つ。保持と保持の間は cosine で加減速する */
type Hold = readonly [from: number, to: number, v: Level];

// ── レールの水平の形 ───────────────────────────────────────────
interface LinePiece {
  readonly kind: 'line';
  readonly len: number;
  /** 輪を閉じるために解く直線 */
  readonly free?: 'a' | 'b';
}
interface TurnPiece {
  readonly kind: 'turn';
  /** 向きの変化（度）。左回りが正 */
  readonly deg: number;
  readonly radius: number;
  /** 曲がり始めと終わりの曲率の変化にかける長さ（m）。向きの回転が急に始まらないように */
  readonly ramp: number;
}
type Piece = LinePiece | TurnPiece;

const line = (len: number): Piece => ({ kind: 'line', len });
const freeLine = (free: 'a' | 'b'): Piece => ({ kind: 'line', len: 0, free });
/** 半径で決める曲がり（植物の間を縫う、乗り場の揺れ） */
const turnR = (deg: number, radius: number, rampMax = 12): Piece => ({
  kind: 'turn',
  deg,
  radius,
  ramp: Math.min(rampMax, Math.abs(deg) * DEG * radius),
});
/** 長さで決める曲がり（輪の大きな弧） */
const turnL = (deg: number, length: number, rampMax = 20): Piece => {
  const ramp = Math.min(rampMax, length / 2);
  return { kind: 'turn', deg, radius: (length - ramp) / (Math.abs(deg) * DEG), ramp };
};
const pieceLength = (p: Piece): number => (p.kind === 'line' ? p.len : Math.abs(p.deg) * DEG * p.radius + p.ramp);

// ── 高さ（ゴンドラの中心。乗り場の水面を 0 とする） ──────────────────
/** 乗り場でゴンドラは水面に浮かぶ（中心は半径の高さ） */
const DOCK_Y = GONDOLA_DIAMETER / 2;
/** 温室の高い位置（全体を見下ろす）と、床の近くの高さ */
const GREENHOUSE_TOP_Y = 8.2;
const GREENHOUSE_BLOOM_Y = 2.6;
/** 雨の回廊と万華鏡の水平の高さ（天井の低い回廊の中央。床から 1.9m、ゴンドラの底は床から 0.7m） */
const CORRIDOR_Y = 1.9;
/** 天球の中心（9:50）の高さ。入口（回廊と同じ高さ）から 6m 以上上がる */
const CELESTIAL_CENTER_Y = CORRIDOR_Y + 6.4;
/** 夜明けの岸は乗り場と同じ水面すれすれ（ゴンドラの底が水面にほぼ触れる）。天球を出た所の高さ */
const SHORE_Y = DOCK_Y + 0.05;

/** 脚の中の進み具合 u（水平の長さの割合）と高さの鍵。鍵の間は cosine でつなぐ（鍵の上では上下の動きが 0） */
type HeightKey = readonly [u: number, y: number];

interface LegSpec {
  readonly section: SectionId;
  /** 同じ区間を2つに分ける脚の名前（天球は中心で分ける） */
  readonly name: string;
  readonly t0: number;
  readonly t1: number;
  readonly holds: readonly Hold[];
  /** 普段の速さ c の上限（m/s） */
  readonly cruiseMax: number;
  readonly pieces: readonly Piece[];
  readonly heights: readonly HeightKey[];
}

/**
 * 脚の設計。輪は時計回りで、乗り場（0,0）から北へ出て、温室で右へ、回廊で右へ曲がり、万華鏡は南東へまっすぐ、
 * 天球で右へ回り込みながら中心へ、中心から先は西へ。夜明けの岸は乗り場へまっすぐ戻る一本道（遠くに乗り場が見える）。
 * 右への曲がりの合計は 270°（北 → 西）。
 * 速さの水準の間（保持の間）は cosine で加減速し、時間は |Δv|·π/(2·時間) ≤ ACCEL_DESIGN_MAX になるように長く取る。
 */
function legSpecs(): readonly LegSpec[] {
  const M = V_MEMBRANE;
  const H = V_HIGHLIGHT;
  return [
    {
      // 乗り場: 水面から浮かんだゴンドラがほぼ止まっている（0〜2.5秒は 0.1 m/s 以下）。ゆっくり浮き上がって北の門へ
      section: 'platform',
      name: 'platform',
      t0: T.platform,
      t1: T.greenhouse,
      holds: [
        [0, 0, 0],
        [RAMP, T.greenhouse - 2 - RAMP_SMALL, 'c'],
        [T.greenhouse - 2, T.greenhouse, M],
      ],
      cruiseMax: MOTION.driftMax,
      pieces: [line(10), turnR(22, 20), turnR(-22, 20), line(8)],
      heights: [
        [0, DOCK_Y],
        [0.1, DOCK_Y],
        [1, GREENHOUSE_TOP_Y],
      ],
    },
    {
      // 朝露の温室: 高い位置から見下ろし、ゆっくり下降して植物の間を縫う。2:40 の花で最も遅く、花の後は静かに次の膜へ
      section: 'greenhouse',
      name: 'greenhouse',
      t0: T.greenhouse,
      t1: T.rain,
      holds: [
        [T.greenhouse, T.greenhouse + ENTRY_HOLD, M],
        [T.greenhouse + ENTRY_HOLD + RAMP, AT.bloom - HOLD_BEFORE - RAMP, 'c'],
        [AT.bloom - HOLD_BEFORE, AT.bloom + HOLD_AFTER, H],
        [AT.bloom + HOLD_AFTER + RAMP, T.rain - 2 - RAMP_SMALL, 'a'],
        [T.rain - 2, T.rain, M],
      ],
      cruiseMax: MOTION.driftMax,
      pieces: [freeLine('a'), turnR(30, 30), line(2), turnR(-70, 30), line(2), turnR(35, 28), line(2), turnR(-40, 28)],
      heights: [
        [0, GREENHOUSE_TOP_Y],
        [0.12, GREENHOUSE_TOP_Y],
        [0.68, GREENHOUSE_BLOOM_Y],
        [1, CORRIDOR_Y],
      ],
    },
    {
      // 雨の回廊: 細長く天井の低い回廊。両端はまっすぐで、間を右へ曲がる。5:10 雨粒が止まる（遅く）、5:50 扉。壁が近いので普段も 1.2 以下
      section: 'rain',
      name: 'rain',
      t0: T.rain,
      t1: T.kaleidoscope,
      holds: [
        [T.rain, T.rain + ENTRY_HOLD, M],
        [T.rain + ENTRY_HOLD + RAMP_SMALL, AT.freeze - HOLD_BEFORE - RAMP, 'c'],
        [AT.freeze - HOLD_BEFORE, AT.freeze + HOLD_AFTER_FREEZE, H],
        [AT.freeze + HOLD_AFTER_FREEZE + RAMP_SMALL, T.kaleidoscope, V_DOORS],
      ],
      cruiseMax: MOTION.corridorMax,
      pieces: [line(10), turnL(-100, 115), line(10)],
      heights: [
        [0, CORRIDOR_Y],
        [1, CORRIDOR_Y],
      ],
    },
    {
      // 万華鏡の間: 部屋の中心をまっすぐ水平に通り抜ける。ゴンドラは回らない（向きが変わらない一本の直線）。7:20 に遅い
      section: 'kaleidoscope',
      name: 'kaleidoscope',
      t0: T.kaleidoscope,
      t1: T.celestial,
      holds: [
        [T.kaleidoscope, T.kaleidoscope + ENTRY_HOLD, V_DOORS],
        [T.kaleidoscope + ENTRY_HOLD + RAMP, AT.flower - HOLD_BEFORE - RAMP, 'c'],
        [AT.flower - HOLD_BEFORE, AT.flower + HOLD_AFTER, H],
        [AT.flower + HOLD_AFTER + RAMP, T.celestial - 2 - RAMP_SMALL, 'a'],
        [T.celestial - 2, T.celestial, M],
      ],
      cruiseMax: MOTION.driftMax,
      pieces: [line(105)],
      heights: [
        [0, CORRIDOR_Y],
        [1, CORRIDOR_Y],
      ],
    },
    {
      // 星の天球（中心まで）: 暗闇の後、球の殻を何枚も通り抜けて右へ回り込みながら上昇し、9:50 に中心で止まる
      section: 'celestial',
      name: 'celestial-in',
      t0: T.celestial,
      t1: AT.constellation,
      holds: [
        [T.celestial, T.celestial + ENTRY_HOLD, M],
        [T.celestial + ENTRY_HOLD + RAMP, AT.constellation - HOLD_BEFORE - RAMP, 'c'],
        [AT.constellation - HOLD_BEFORE, AT.constellation, H],
      ],
      cruiseMax: MOTION.driftMax,
      pieces: [turnL(-110, 105)],
      heights: [
        [0, CORRIDOR_Y],
        [1, CELESTIAL_CENTER_Y],
      ],
    },
    {
      // 星の天球（中心から先）: 中心から外へ、殻を抜けて岸へゆるく下りる
      section: 'celestial',
      name: 'celestial-out',
      t0: AT.constellation,
      t1: T.dawn,
      holds: [
        [AT.constellation, AT.constellation + HOLD_AFTER, H],
        [AT.constellation + HOLD_AFTER + RAMP, T.dawn - 2 - RAMP_SMALL, 'a'],
        [T.dawn - 2, T.dawn, M],
      ],
      cruiseMax: MOTION.driftMax,
      pieces: [turnL(-15, 62)],
      heights: [
        [0, CELESTIAL_CENTER_Y],
        [1, SHORE_Y],
      ],
    },
    {
      // 夜明けの岸: 水面すれすれを平らに。乗り場へまっすぐ戻る。11:50 朝日、その後は静かに降車の門へ
      section: 'dawn',
      name: 'dawn',
      t0: T.dawn,
      t1: T.departure,
      holds: [
        [T.dawn, T.dawn + ENTRY_HOLD, M],
        [T.dawn + ENTRY_HOLD + RAMP_SMALL, AT.sunrise - HOLD_BEFORE - RAMP, 'c'],
        [AT.sunrise - HOLD_BEFORE, AT.sunrise + HOLD_AFTER, H],
        [AT.sunrise + HOLD_AFTER + RAMP, T.departure - 2 - RAMP_SMALL, 'a'],
        [T.departure - 2, T.departure, M],
      ],
      cruiseMax: MOTION.driftMax,
      pieces: [freeLine('b')],
      heights: [
        [0, SHORE_Y],
        [1, DOCK_Y],
      ],
    },
    {
      // 降車: 乗り場のホールに戻り、776〜780秒はほぼ止まる。長さは速度の積分で決まる（水面と同じ高さを平らに）
      section: 'departure',
      name: 'departure',
      t0: T.departure,
      t1: T.end,
      holds: [
        [T.departure, T.departure + ENTRY_HOLD, M],
        [T.end - 2, T.end, 0],
      ],
      cruiseMax: MOTION.driftMax,
      pieces: [line(0)], // 長さは速度の積分で入れる
      heights: [
        [0, DOCK_Y],
        [1, DOCK_Y],
      ],
    },
  ];
}

// ── 速度の積分 ─────────────────────────────────────────────────
interface Key {
  readonly t: number;
  readonly v: number;
}

/** 保持の並びを、c を入れた鍵の列にする（保持の両端が鍵。鍵の間は cosine） */
function keysOf(holds: readonly Hold[], c: number): Key[] {
  const a = Math.min(c, MOTION.afterHighlightMax);
  const keys: Key[] = [];
  for (const [from, to, level] of holds) {
    const v = level === 'c' ? c : level === 'a' ? a : level;
    keys.push({ t: from, v });
    if (to > from) keys.push({ t: to, v });
  }
  return keys;
}

/** 鍵の列の ∫v dt。cosine の加減速の平均は両端の平均なので台形になる */
function integral(keys: readonly Key[]): number {
  let sum = 0;
  for (let i = 1; i < keys.length; i++) sum += ((keys[i].t - keys[i - 1].t) * (keys[i].v + keys[i - 1].v)) / 2;
  return sum;
}

/** 脚の中の時刻 t までの距離（m）。鍵の間は cosine の積分で厳密に */
function distance(keys: readonly Key[], t: number): number {
  let dist = 0;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    const h = b.t - a.t;
    if (t >= b.t) {
      dist += (h * (a.v + b.v)) / 2;
      continue;
    }
    if (t > a.t) {
      const tau = t - a.t;
      dist += a.v * tau + (b.v - a.v) * (tau / 2 - (h / (2 * Math.PI)) * Math.sin((Math.PI * tau) / h));
    }
    break;
  }
  return dist;
}

const hasCruise = (holds: readonly Hold[]) => holds.some((h) => h[2] === 'c' || h[2] === 'a');

/** 脚の3Dの長さに合う普段の速さ c を二分探索で解く（c が大きいほど積分は大きい）。上限を超える長さは problems に書く */
function solveCruise(leg: LegSpec, length: number, problems: string[]): number | null {
  if (!hasCruise(leg.holds)) {
    if (Math.abs(integral(keysOf(leg.holds, 0)) - length) > 1e-6) problems.push(`固定の脚 ${leg.name} の長さが速度の積分と合わない`);
    return null;
  }
  let lo = 0;
  let hi = leg.cruiseMax;
  if (integral(keysOf(leg.holds, hi)) < length) {
    problems.push(`脚 ${leg.name}: 長さ ${length.toFixed(1)} m は普段の速さの上限 ${hi} m/s でも走りきれない（最大 ${integral(keysOf(leg.holds, hi)).toFixed(1)} m）。レールを短くする`);
    return hi;
  }
  if (integral(keysOf(leg.holds, 0)) > length) {
    problems.push(`脚 ${leg.name}: 長さ ${length.toFixed(1)} m は速さの設計の最小 ${integral(keysOf(leg.holds, 0)).toFixed(1)} m より短い`);
    return 0;
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (integral(keysOf(leg.holds, mid)) < length) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── 高さ ───────────────────────────────────────────────────────
function legHeight(keys: readonly HeightKey[], u: number): number {
  if (u <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (u <= keys[i][0]) {
      const [u0, y0] = keys[i - 1];
      const [u1, y1] = keys[i];
      const f = (u - u0) / (u1 - u0);
      return y0 + ((y1 - y0) * (1 - Math.cos(Math.PI * f))) / 2;
    }
  }
  return keys[keys.length - 1][1];
}

// ── 水平の形を積分する ─────────────────────────────────────────
const STEP = 0.025;

interface Walk {
  /** 各ステップの水平の距離・位置・向き（左回りが正） */
  readonly s: Float64Array;
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly h: Float64Array;
  /** 各部品の始まり */
  readonly marks: { s: number; h: number; x: number; z: number }[];
  readonly length: number;
}

const smooth01 = (x: number) => x * x * (3 - 2 * x);

function walk(pieces: readonly Piece[]): Walk {
  const sList: number[] = [0];
  const xList: number[] = [0];
  const zList: number[] = [0];
  const hList: number[] = [0];
  const marks: { s: number; h: number; x: number; z: number }[] = [];
  let s = 0;
  let x = 0;
  let z = 0;
  let h = 0;
  for (const p of pieces) {
    marks.push({ s, h, x, z });
    const len = pieceLength(p);
    if (len <= 0) continue;
    const n = Math.max(1, Math.round(len / STEP));
    const step = len / n;
    // 曲がりは重み（曲率の形）を先に作り、向きの変化の合計がちょうど deg になるよう正規化する
    let w: Float64Array | null = null;
    let scale = 0;
    if (p.kind === 'turn') {
      w = new Float64Array(n);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const u = (i + 0.5) * step;
        let v = 1;
        if (u < p.ramp) v = smooth01(u / p.ramp);
        else if (u > len - p.ramp) v = smooth01((len - u) / p.ramp);
        w[i] = v;
        sum += v * step;
      }
      scale = (p.deg * DEG) / sum;
    }
    for (let i = 0; i < n; i++) {
      const dh = w ? w[i] * scale * step : 0;
      const hm = h + dh / 2;
      x += -Math.sin(hm) * step;
      z += -Math.cos(hm) * step;
      h += dh;
      s += step;
      sList.push(s);
      xList.push(x);
      zList.push(z);
      hList.push(h);
    }
  }
  marks.push({ s, h, x, z });
  return { s: Float64Array.from(sList), x: Float64Array.from(xList), z: Float64Array.from(zList), h: Float64Array.from(hList), marks, length: s };
}

/** 部品の列（自由な直線 a, b と降車の長さを入れたもの）。降車の長さは速度の積分（平らなので水平の長さと同じ） */
function resolvePieces(specs: readonly LegSpec[], a: number, b: number, depLen: number): { pieces: Piece[]; range: { from: number; to: number }[] } {
  const pieces: Piece[] = [];
  const range: { from: number; to: number }[] = [];
  for (const leg of specs) {
    const from = pieces.length;
    for (const p of leg.pieces) {
      if (p.kind === 'line' && p.free === 'a') pieces.push({ kind: 'line', len: a });
      else if (p.kind === 'line' && p.free === 'b') pieces.push({ kind: 'line', len: b });
      else if (leg.section === 'departure') pieces.push({ kind: 'line', len: depLen });
      else pieces.push(p);
    }
    range.push({ from, to: pieces.length });
  }
  return { pieces, range };
}

/** 輪を閉じるための直線 a（温室の頭）と b（夜明けの岸）の長さを解く。終点の位置は a, b に線形なので 2×2 で解ける */
function closeLoop(specs: readonly LegSpec[], depLen: number): { a: number; b: number } {
  const w0 = walk(resolvePieces(specs, 0, 0, depLen).pieces);
  const flat = specs.flatMap((leg) => leg.pieces);
  const idxA = flat.findIndex((p) => p.kind === 'line' && p.free === 'a');
  const idxB = flat.findIndex((p) => p.kind === 'line' && p.free === 'b');
  const ha = w0.marks[idxA].h;
  const hb = w0.marks[idxB].h;
  const ua = [-Math.sin(ha), -Math.cos(ha)];
  const ub = [-Math.sin(hb), -Math.cos(hb)];
  const ex = w0.x[w0.x.length - 1];
  const ez = w0.z[w0.z.length - 1];
  const det = ua[0] * ub[1] - ua[1] * ub[0];
  // 終点 = e + a*ua + b*ub = 0（乗り場の始点 (0,0)）
  return { a: (-ex * ub[1] + ez * ub[0]) / det, b: (-ua[0] * ez + ua[1] * ex) / det };
}

// ── 組み立て ───────────────────────────────────────────────────
export interface LegInfo {
  readonly name: string;
  readonly section: SectionId;
  readonly t0: number;
  readonly t1: number;
  /** 3Dの弧長（m） */
  readonly s0: number;
  readonly s1: number;
  /** 普段の速さ c（m/s）。固定の脚では null */
  readonly cruise: number | null;
  /** 脚の中の最大の速さ（m/s） */
  readonly maxSpeed: number;
  /** 脚の中の高さの範囲（m） */
  readonly yMin: number;
  readonly yMax: number;
}

/** 部屋の担当が物を置くときの目印（ride.pointAt / poseAt と同じ座標。yaw は three.js の rotation.y） */
export interface Landmark {
  readonly t: number;
  readonly s: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

export type HighlightName = Extract<
  CueName,
  'greenhouse.bloom' | 'rain.freeze' | 'rain.doors' | 'kaleidoscope.flower' | 'celestial.constellation' | 'dawn.sunrise'
>;

export interface DesignInfo {
  readonly legs: readonly LegInfo[];
  readonly freeLines: { readonly a: number; readonly b: number };
  /** 輪の終点と始点の距離（m、水平） */
  readonly closureGap: number;
  /** 設計が成り立っていない所（普段の速さの上限を超える長さなど）。空なら問題なし。generateRideData は問題があれば例外を投げる */
  readonly problems: readonly string[];
  /** 乗り場の始点（ゴンドラが水面に浮かぶ所） */
  readonly dock: Landmark;
  /** 部屋の境目の膜（通り抜ける瞬間の位置と向き）。to は入る区間 */
  readonly membranes: readonly (Landmark & { readonly to: SectionId })[];
  /** 見どころの時刻のゴンドラの位置（物はこの点を基準に置く） */
  readonly highlights: Readonly<Record<HighlightName, Landmark>>;
  /** 乗り場のホール（始点・北の門・降車の門を通る円） */
  readonly hall: { readonly x: number; readonly z: number; readonly radius: number };
  /**
   * 天球の中心（9:50 のゴンドラの位置）と、入口の膜・出口の膜までの距離（3D、m）。
   * 殻は出口までの距離（exitRadius）より内側に重ねると、岸と重ならない
   */
  readonly celestial: { readonly center: Landmark; readonly entryRadius: number; readonly exitRadius: number };
  /** 床と水面の想定の高さ（m）。ゴンドラの中心の高さとの差が、床や水面からの余裕 */
  readonly floors: { readonly platformWater: number; readonly greenhouseFloor: number; readonly rainFloor: number; readonly dawnWater: number };
}

const round = (v: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

type DesignCore = Pick<DesignInfo, 'legs' | 'freeLines' | 'closureGap' | 'problems'>;

function designAll(): { data: RideData; info: DesignCore } {
  const problems: string[] = [];
  const specs = legSpecs();

  // 1. 水平の形（降車の長さは速度の積分。平らなので水平の長さと同じ）
  const dep = specs[specs.length - 1];
  const depLen = integral(keysOf(dep.holds, 0));
  const { a, b } = closeLoop(specs, depLen);
  if (a < 0 || b < 0) problems.push(`輪を閉じる直線が負（温室の頭 ${a.toFixed(1)} m、夜明けの岸 ${b.toFixed(1)} m）。曲がりの角度か長さを直す`);
  const { pieces, range } = resolvePieces(specs, Math.max(0, a), Math.max(0, b), depLen);
  // 点が終点の先まで届くよう、終点から 2m の直線を足す（pointAt が端に丸める）
  const path = walk([...pieces, line(2)]);
  const n = path.s.length;

  // 2. 高さと3Dの弧長
  const legH0: number[] = [];
  const legH1: number[] = [];
  for (let i = 0; i < specs.length; i++) {
    legH0.push(path.marks[range[i].from].s);
    legH1.push(path.marks[range[i].to].s);
  }
  const y = new Float64Array(n);
  const s3 = new Float64Array(n);
  let li = 0;
  for (let k = 0; k < n; k++) {
    const h = path.s[k];
    while (li < specs.length - 1 && h > legH1[li] + 1e-9) li++;
    const len = legH1[li] - legH0[li];
    y[k] = h > legH1[specs.length - 1] ? DOCK_Y : legHeight(specs[li].heights, len > 0 ? Math.min(1, Math.max(0, (h - legH0[li]) / len)) : 1);
    if (k > 0) s3[k] = s3[k - 1] + Math.hypot(path.s[k] - path.s[k - 1], y[k] - y[k - 1]);
  }
  /** 水平の距離 h の3Dの弧長（脚の境目は点の上にある） */
  const s3At = (h: number): number => {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (path.s[mid] < h - 1e-9) lo = mid + 1;
      else hi = mid;
    }
    return s3[lo];
  };

  // 3. 脚ごとの3Dの長さと、普段の速さ
  const legs: LegInfo[] = [];
  const keyList: Key[][] = [];
  for (let i = 0; i < specs.length; i++) {
    const leg = specs[i];
    const s0 = s3At(legH0[i]);
    const s1 = s3At(legH1[i]);
    const c = solveCruise(leg, s1 - s0, problems);
    const keys = keysOf(leg.holds, c ?? 0);
    keyList.push(keys);
    // 保持の間の加減速が設計の上限を超えないか
    for (let j = 1; j < keys.length; j++) {
      const dt = keys[j].t - keys[j - 1].t;
      const peak = dt > 0 ? (Math.abs(keys[j].v - keys[j - 1].v) * Math.PI) / (2 * dt) : keys[j].v === keys[j - 1].v ? 0 : Infinity;
      if (peak > ACCEL_DESIGN_MAX) problems.push(`脚 ${leg.name}: ${keys[j - 1].t.toFixed(1)}〜${keys[j].t.toFixed(1)} 秒の加減速 ${peak.toFixed(3)} m/s² が設計の上限 ${ACCEL_DESIGN_MAX} を超える`);
    }
    if (keys[0].t !== leg.t0 || keys[keys.length - 1].t !== leg.t1) problems.push(`脚 ${leg.name}: 速さの保持が脚の時刻の範囲を埋めていない`);
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let k = 0; k < n; k++) {
      if (path.s[k] >= legH0[i] - 1e-9 && path.s[k] <= legH1[i] + 1e-9) {
        yMin = Math.min(yMin, y[k]);
        yMax = Math.max(yMax, y[k]);
      }
    }
    legs.push({
      name: leg.name,
      section: leg.section,
      t0: leg.t0,
      t1: leg.t1,
      s0,
      s1,
      cruise: c,
      maxSpeed: Math.max(...keys.map((k) => k.v)),
      yMin,
      yMax,
    });
  }

  // 4. 時刻表（t → s、3Dの弧長）
  const distanceAt = (t: number): number => {
    let i = legs.findIndex((l) => t < l.t1);
    if (i < 0) i = legs.length - 1;
    return legs[i].s0 + distance(keyList[i], Math.min(t, legs[i].t1));
  };
  const timeline: { t: number; s: number }[] = [];
  const steps = Math.round(RIDE_DURATION / TIMELINE_DT);
  for (let k = 0; k <= steps; k++) timeline.push({ t: round(k * TIMELINE_DT, 4), s: round(distanceAt(k * TIMELINE_DT), 5) });
  const total = legs[legs.length - 1].s1;

  // 5. 点列: 3D で 1m の等間隔に打つ（s = 点の番号）
  const pointCount = Math.ceil(total) + 1;
  const points: Vec3Tuple[] = [];
  let k = 0;
  for (let i = 0; i < pointCount; i++) {
    while (k < n - 2 && s3[k + 1] < i) k++;
    const span = s3[k + 1] - s3[k];
    const f = span > 0 ? Math.min(1, Math.max(0, (i - s3[k]) / span)) : 0;
    points.push([
      round(path.x[k] + (path.x[k + 1] - path.x[k]) * f, 3),
      round(y[k] + (y[k + 1] - y[k]) * f, 3),
      round(path.z[k] + (path.z[k + 1] - path.z[k]) * f, 3),
    ]);
  }

  // 区間（同じ区間の脚をまとめる）
  const sections: { id: SectionId; s0: number; s1: number }[] = [];
  for (const leg of legs) {
    const last = sections[sections.length - 1];
    if (last && last.id === leg.section) last.s1 = round(leg.s1, 5);
    else sections.push({ id: leg.section, s0: round(leg.s0, 5), s1: round(leg.s1, 5) });
  }

  // 各部屋の平均の速さは 0.8〜cruiseMax（景色を眺められる速さ）
  for (const sec of sections) {
    if (sec.id === 'platform' || sec.id === 'departure') continue;
    const avg = (sec.s1 - sec.s0) / (SECTIONS.find((x) => x.id === sec.id)!.bars * SEC_PER_BAR);
    if (avg < 0.8 || avg > MOTION.cruiseMax) problems.push(`区間 ${sec.id}: 平均 ${avg.toFixed(2)} m/s が 0.8〜${MOTION.cruiseMax} の外`);
  }

  // 輪の閉じ具合（脚の終わりの水平の位置）
  const endMark = path.marks[range[range.length - 1].to];
  const data: RideData = { version: 1, duration: RIDE_DURATION, rail: { spacing: 1, points }, timeline, sections };
  return { data, info: { legs, freeLines: { a, b }, closureGap: Math.hypot(endMark.x, endMark.z), problems } };
}

/** レールと時刻表を作る（Blender の書き出しの代わり。scripts/build-ride-data.ts が rail.json に書く）。設計が成り立たなければ例外 */
export function generateRideData(): RideData {
  const { data, info } = designAll();
  if (info.problems.length > 0) throw new Error(`レールの設計が成り立たない:\n${info.problems.join('\n')}`);
  return data;
}

/** 設計の要約（脚ごとの距離と普段の速さ、輪の閉じ具合）と、部屋の担当が使う目印。build-ride-data.ts と確認ページが使う */
export function describeDesign(): DesignInfo {
  const { data, info } = designAll();
  const ride = createRide(data);
  const pose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform' as SectionId, sectionProgress: 0 };
  const mark = (t: number): Landmark => {
    ride.poseAt(t, 'standard', pose);
    return { t, s: pose.s, x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw };
  };
  const membranes = SECTIONS.slice(1).map((sec) => ({ ...mark(sec.startBar * SEC_PER_BAR), to: sec.id }));
  const highlights: Record<HighlightName, Landmark> = {
    'greenhouse.bloom': mark(AT.bloom),
    'rain.freeze': mark(AT.freeze),
    'rain.doors': mark(MOMENT_BARS.rainDoors * SEC_PER_BAR),
    'kaleidoscope.flower': mark(AT.flower),
    'celestial.constellation': mark(AT.constellation),
    'dawn.sunrise': mark(AT.sunrise),
  };
  const center = highlights['celestial.constellation'];
  const dist = (p: Landmark) => Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z);
  // 乗り場のホール: 始点・北の門・降車の門の3点を通る円
  const dock = mark(0);
  const gate = membranes[0];
  const back = membranes[membranes.length - 1];
  const d = 2 * (dock.x * (gate.z - back.z) + gate.x * (back.z - dock.z) + back.x * (dock.z - gate.z));
  const sq = (p: Landmark) => p.x * p.x + p.z * p.z;
  const hx = (sq(dock) * (gate.z - back.z) + sq(gate) * (back.z - dock.z) + sq(back) * (dock.z - gate.z)) / d;
  const hz = (sq(dock) * (back.x - gate.x) + sq(gate) * (dock.x - back.x) + sq(back) * (gate.x - dock.x)) / d;
  return {
    ...info,
    dock,
    membranes,
    highlights,
    hall: { x: hx, z: hz, radius: Math.hypot(dock.x - hx, dock.z - hz) },
    celestial: { center, entryRadius: dist(membranes[3]), exitRadius: dist(membranes[4]) },
    // 乗り場と岸は同じ水面（ゴンドラの底が水面に浮かぶ）。温室と回廊の床は 0
    floors: { platformWater: DOCK_Y - GONDOLA_DIAMETER / 2, greenhouseFloor: 0, rainFloor: 0, dawnWater: DOCK_Y - GONDOLA_DIAMETER / 2 },
  };
}
