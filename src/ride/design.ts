// レールと時刻表の設計（Blender のプレビズの代わりにコードで作る。ADR-0002）。
//
// 流れ（時刻から決める）:
//   1. 区間ごとの「速度の設計表」（時刻と速度の鍵。cosine で滑らかにつなぐ）を決める。普段の速さ c だけ未知。
//   2. レールの水平の形を「進んで曲がる」の列で決める。曲がり始めと終わりは曲率を滑らかに変える（向きの回転が急に始まらない）。
//      輪を閉じる（降車の終点が乗り場の始点）ために、2か所の直線の長さだけを連立方程式で解く。
//   3. 各区間のレールの長さ = 速度の積分、となるように c を解く。時刻表（t → s）は速度の積分で作る。
//   4. 高さは時刻の鍵で決め、レールの点の時刻に当てはめる。穏やかモードの高さは「上下の動きを半分にした高さ」。
//
// 部屋の形はこのレールの点（ride.pointAt）を基準に置く。形の要点は docs ではなく dev/ride.html の地図で見る。
import { MOMENT_BARS, RIDE_DURATION, SEC_PER_BAR, SECTIONS } from '../config';
import type { Vec3Tuple } from '../contracts/events';
import type { SectionId } from '../contracts/ids';
import type { RideData } from '../contracts/ride';

const DEG = Math.PI / 180;

// ── 速度の設計（m/s） ──────────────────────────────────────────
/** 膜の前後（入口）の速さ。膜の3秒後は 1.2 m/s 以下、「入口では減速」を満たす */
const V_GATE = 0.85;
/** 見どころの間の速さ（ほとんど止まっているように感じる。MOTION.highlightSpeed 0.5 より少し遅い） */
const V_HIGHLIGHT = 0.45;
/** 扉が現れてから膜までの速さ（選ぶ時間を作る） */
const V_DOORS = 0.8;
/** 時刻表の細かさ（秒）。poseAt はこの点の間を滑らかに補う */
const TIMELINE_DT = 0.25;

type Cruise = 'c';
type Key = readonly [t: number, v: number | Cruise];

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

interface LegSpec {
  readonly section: SectionId;
  /** 同じ区間を2つに分ける脚の名前（天球は中心で分ける） */
  readonly name: string;
  readonly t0: number;
  readonly t1: number;
  readonly keys: readonly Key[];
  readonly pieces: readonly Piece[];
}

/**
 * 脚（区間、天球だけ中心の前後で2つ）の設計。
 * 輪は時計回りで、乗り場（0,0）から北へ出て、温室で右へ、回廊で大きく右へ曲がり、万華鏡は南東へまっすぐ、
 * 天球で右へ回り込みながら中心へ、中心から先は西へ。夜明けの岸は乗り場へまっすぐ戻る一本道（遠くに乗り場が見える）。
 * 右への曲がりの合計は 270°（北 → 西）。
 */
function legSpecs(): readonly LegSpec[] {
  return [
    {
      // 乗り場: 水面から浮かんだゴンドラがほぼ止まっている（0〜2.5秒は 0.1 m/s 以下）。ゆっくり浮き上がって北の門へ
      section: 'platform',
      name: 'platform',
      t0: T.platform,
      t1: T.greenhouse,
      keys: [
        [0, 0],
        [14, 'c'],
        [T.greenhouse - 12, 'c'],
        [T.greenhouse - 2, V_GATE],
        [T.greenhouse, V_GATE],
      ],
      pieces: [line(12), turnR(22, 20), turnR(-22, 20), line(12)],
    },
    {
      // 朝露の温室: 高い位置から見下ろし、ゆっくり下降して植物の間を縫う。2:40 の花で最も遅く
      section: 'greenhouse',
      name: 'greenhouse',
      t0: T.greenhouse,
      t1: T.rain,
      keys: [
        [T.greenhouse, V_GATE],
        [T.greenhouse + 8, V_GATE],
        [T.greenhouse + 22, 'c'],
        [AT.bloom - 14, 'c'],
        [AT.bloom - 4, V_HIGHLIGHT],
        [AT.bloom + 8, V_HIGHLIGHT],
        [AT.bloom + 20, 'c'],
        [T.rain - 12, 'c'],
        [T.rain - 2, V_GATE],
        [T.rain, V_GATE],
      ],
      pieces: [
        freeLine('a'),
        turnR(45, 34),
        line(4),
        turnR(-100, 34),
        line(4),
        turnR(50, 32),
        line(4),
        turnR(-50, 32),
      ],
    },
    {
      // 雨の回廊: 細長く天井の低い回廊。両端はまっすぐで、間を大きく右へ曲がる。5:10 雨粒が止まる（遅く）、5:50 扉
      section: 'rain',
      name: 'rain',
      t0: T.rain,
      t1: T.kaleidoscope,
      keys: [
        [T.rain, V_GATE],
        [T.rain + 8, V_GATE],
        [T.rain + 22, 'c'],
        [AT.freeze - 14, 'c'],
        [AT.freeze - 4, V_HIGHLIGHT],
        [AT.freeze + 14, V_HIGHLIGHT],
        [AT.freeze + 28, V_DOORS],
        [T.kaleidoscope, V_DOORS],
      ],
      pieces: [line(15), turnL(-90, 130), line(15)],
    },
    {
      // 万華鏡の間: 部屋の中心をまっすぐゆっくり通り抜ける。ゴンドラは回らない（向きが変わらない一本の直線）
      section: 'kaleidoscope',
      name: 'kaleidoscope',
      t0: T.kaleidoscope,
      t1: T.celestial,
      keys: [
        [T.kaleidoscope, V_DOORS],
        [T.kaleidoscope + 8, V_DOORS],
        [T.kaleidoscope + 24, 'c'],
        [AT.flower - 14, 'c'],
        [AT.flower - 4, V_HIGHLIGHT],
        [AT.flower + 8, V_HIGHLIGHT],
        [AT.flower + 20, 'c'],
        [T.celestial - 12, 'c'],
        [T.celestial - 2, V_GATE],
        [T.celestial, V_GATE],
      ],
      pieces: [line(110)],
    },
    {
      // 星の天球（中心まで）: 暗闇の後、球の殻を何枚も通り抜けて右へ回り込みながら上昇し、9:50 に中心で止まる
      section: 'celestial',
      name: 'celestial-in',
      t0: T.celestial,
      t1: AT.constellation,
      keys: [
        [T.celestial, V_GATE],
        [T.celestial + 8, V_GATE],
        [T.celestial + 22, 'c'],
        [AT.constellation - 14, 'c'],
        [AT.constellation - 4, V_HIGHLIGHT],
        [AT.constellation, V_HIGHLIGHT],
      ],
      pieces: [turnL(-95, 112)],
    },
    {
      // 星の天球（中心から先）: 中心から外へ、殻を抜けて岸へ
      section: 'celestial',
      name: 'celestial-out',
      t0: AT.constellation,
      t1: T.dawn,
      keys: [
        [AT.constellation, V_HIGHLIGHT],
        [AT.constellation + 8, V_HIGHLIGHT],
        [AT.constellation + 20, 'c'],
        [T.dawn - 12, 'c'],
        [T.dawn - 2, V_GATE],
        [T.dawn, V_GATE],
      ],
      pieces: [turnL(-30, 90)],
    },
    {
      // 夜明けの岸: 水面すれすれを平らに。乗り場へまっすぐ戻る。11:50 朝日
      section: 'dawn',
      name: 'dawn',
      t0: T.dawn,
      t1: T.departure,
      keys: [
        [T.dawn, V_GATE],
        [T.dawn + 8, V_GATE],
        [T.dawn + 22, 'c'],
        [AT.sunrise - 14, 'c'],
        [AT.sunrise - 4, V_HIGHLIGHT],
        [AT.sunrise + 8, V_HIGHLIGHT],
        [AT.sunrise + 20, 'c'],
        [T.departure - 12, 'c'],
        [T.departure - 2, V_GATE],
        [T.departure, V_GATE],
      ],
      pieces: [freeLine('b')],
    },
    {
      // 降車: 乗り場のホールに戻り、776〜780秒はほぼ止まる。長さは速度の積分で決まる
      section: 'departure',
      name: 'departure',
      t0: T.departure,
      t1: T.end,
      keys: [
        [T.departure, V_GATE],
        [T.departure + 8, V_GATE],
        [T.end - 2, 0],
        [T.end, 0],
      ],
      pieces: [line(0)], // 長さは速度の積分で入れる
    },
  ];
}

// ── 速度の積分 ─────────────────────────────────────────────────
interface Resolved {
  readonly t: number;
  readonly v: number;
}

/** 鍵の列（'c' を値にしたもの）の中の速度。鍵の間は cosine で滑らかにつなぐ（加速度が鍵でつながる） */
function legIntegral(keys: readonly Resolved[]): number {
  let sum = 0;
  for (let i = 1; i < keys.length; i++) sum += ((keys[i].t - keys[i - 1].t) * (keys[i].v + keys[i - 1].v)) / 2;
  return sum;
}

/** 'c' の係数と定数に分けた積分: ∫v dt = base + coef * c */
function legLinear(keys: readonly Key[]): { base: number; coef: number } {
  const at = (k: Key, c: number) => (k[1] === 'c' ? c : k[1]);
  const f0 = legIntegral(keys.map((k) => ({ t: k[0], v: at(k, 0) })));
  const f1 = legIntegral(keys.map((k) => ({ t: k[0], v: at(k, 1) })));
  return { base: f0, coef: f1 - f0 };
}

/** 脚の中の時刻 t までの距離（m）。鍵の間は cosine の積分で厳密に */
function legDistance(keys: readonly Resolved[], t: number): number {
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

// ── 高さの設計（時刻の鍵。cosine でつなぐ） ───────────────────────
/** ゴンドラの中心の高さ。乗り場の水面を 0 とし、ゴンドラは水面に 1.2m（半径）浮かぶ */
const DOCK_Y = 1.2;
const HEIGHT_KEYS: readonly (readonly [number, number])[] = [
  // 乗り場: ゆっくり浮き上がり、門で高い位置へ
  [0, DOCK_Y],
  [8, DOCK_Y],
  [T.greenhouse, 7.0],
  // 温室: 高い位置から見下ろし（入って 10 秒ほどは高いまま）、ゆっくり下降して花の高さへ
  [T.greenhouse + 12, 7.0],
  [AT.bloom - 10, 2.6],
  [T.rain, 2.4],
  // 雨の回廊: 天井の低い回廊の高さで平ら
  [T.rain + 26, 1.6],
  [T.kaleidoscope, 1.6],
  // 万華鏡の間: ほとんど平らに、ごくゆっくり下がる（天球の最下層へ）
  [T.kaleidoscope + 12, 1.6],
  [T.celestial - 10, -3.5],
  // 天球: 最下層から殻を抜けて上昇し、中心（9:50）で最も高く、岸へ少し下る
  [T.celestial + 12, -3.5],
  [AT.constellation, 5.5],
  [T.dawn, 4.5],
  // 夜明けの岸: 水面すれすれを平らに（上下 1m 以内）
  [T.departure, 4.0],
  // 降車: 乗り場の水面へ降り、最後の 12 秒は高さを変えない（止まる直前に点の間隔が伸びないように）
  [T.end - 12, DOCK_Y],
  [T.end, DOCK_Y],
];

function heightAt(t: number): number {
  const keys = HEIGHT_KEYS;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, y0] = keys[i - 1];
      const [t1, y1] = keys[i];
      const u = (t - t0) / (t1 - t0);
      return y0 + ((y1 - y0) * (1 - Math.cos(Math.PI * u))) / 2;
    }
  }
  return keys[keys.length - 1][1];
}

// ── 水平の形を積分する ─────────────────────────────────────────
const STEP = 0.025;

interface Walk {
  /** 各ステップの距離・位置・向き（左回りが正） */
  readonly s: Float64Array;
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly h: Float64Array;
  /** 各部品の始まりの距離と、そこでの向き */
  readonly marks: { s: number; h: number; x: number; z: number }[];
  readonly length: number;
}

const smooth01 = (x: number) => x * x * (3 - 2 * x);

function walk(pieces: readonly Piece[], extraTail = 0): Walk {
  const sList: number[] = [0];
  const xList: number[] = [0];
  const zList: number[] = [0];
  const hList: number[] = [0];
  const marks: { s: number; h: number; x: number; z: number }[] = [];
  let s = 0;
  let x = 0;
  let z = 0;
  let h = 0;
  const all: Piece[] = extraTail > 0 ? [...pieces, { kind: 'line', len: extraTail }] : [...pieces];
  for (const p of all) {
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
  return {
    s: Float64Array.from(sList),
    x: Float64Array.from(xList),
    z: Float64Array.from(zList),
    h: Float64Array.from(hList),
    marks,
    length: s,
  };
}

/** 輪を閉じるための直線 a（温室の頭）と b（夜明けの岸）の長さを解く。終点の位置は a, b に線形なので 2×2 で解ける */
function closeLoop(legs: readonly LegSpec[], depLen: number): { a: number; b: number } {
  const build = (a: number, b: number) =>
    legs.flatMap((leg) =>
      leg.pieces.map((p): Piece => {
        if (p.kind === 'line' && p.free === 'a') return { kind: 'line', len: a };
        if (p.kind === 'line' && p.free === 'b') return { kind: 'line', len: b };
        if (leg.section === 'departure') return { kind: 'line', len: depLen };
        return p;
      }),
    );
  const w0 = walk(build(0, 0));
  const flat = legs.flatMap((leg) => leg.pieces);
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
  return {
    a: (-ex * ub[1] + ez * ub[0]) / det,
    b: (-ua[0] * ez + ua[1] * ex) / det,
  };
}

// ── 組み立て ───────────────────────────────────────────────────
export interface LegInfo {
  readonly name: string;
  readonly section: SectionId;
  readonly t0: number;
  readonly t1: number;
  readonly s0: number;
  readonly s1: number;
  /** 普段の速さ c（m/s）。固定の脚では null */
  readonly cruise: number | null;
}

export interface DesignInfo {
  readonly legs: readonly LegInfo[];
  readonly freeLines: { readonly a: number; readonly b: number };
  /** 輪の終点と始点の距離（m、水平） */
  readonly closureGap: number;
}

const round = (v: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

function designAll(): { data: RideData; info: DesignInfo } {
  const specs = legSpecs();
  const dep = specs[specs.length - 1];
  const depLen = legIntegral(dep.keys.map((k) => ({ t: k[0], v: k[1] === 'c' ? 0 : k[1] })));
  const { a, b } = closeLoop(specs, depLen);

  // 実際の部品列（自由な直線と降車の長さを入れたもの）
  const pieces: Piece[] = [];
  const legPieceRange: { from: number; to: number }[] = [];
  for (const leg of specs) {
    const from = pieces.length;
    for (const p of leg.pieces) {
      if (p.kind === 'line' && p.free === 'a') pieces.push({ kind: 'line', len: a });
      else if (p.kind === 'line' && p.free === 'b') pieces.push({ kind: 'line', len: b });
      else if (leg.section === 'departure') pieces.push({ kind: 'line', len: depLen });
      else pieces.push(p);
    }
    legPieceRange.push({ from, to: pieces.length });
  }
  const lengths = pieces.map(pieceLength);
  const total = lengths.reduce((x, y) => x + y, 0);
  const pointCount = Math.ceil(total) + 1; // 終点の先に最大 1m の余白（pointAt が端に丸める）
  const path = walk(pieces, Math.ceil(total) - total + 0.5);

  // 脚ごとの距離の範囲と、普段の速さ c
  const legs: LegInfo[] = [];
  const resolved: Resolved[][] = [];
  let sCursor = 0;
  specs.forEach((leg, i) => {
    const len = lengths.slice(legPieceRange[i].from, legPieceRange[i].to).reduce((x, y) => x + y, 0);
    const { base, coef } = legLinear(leg.keys);
    const cruise = coef > 1e-9 ? (len - base) / coef : null;
    if (cruise !== null && (cruise < 0.8 || cruise > 2.0)) {
      throw new Error(`脚 ${leg.name} の普段の速さ ${cruise.toFixed(2)} m/s が 0.8〜2.0 の外（長さ ${len.toFixed(1)} m）。レールの形か速度の設計を直す`);
    }
    if (cruise === null && Math.abs(base - len) > 1e-6) throw new Error(`固定の脚 ${leg.name} の長さが速度の積分と合わない`);
    resolved.push(leg.keys.map((k) => ({ t: k[0], v: k[1] === 'c' ? (cruise as number) : k[1] })));
    legs.push({ name: leg.name, section: leg.section, t0: leg.t0, t1: leg.t1, s0: sCursor, s1: sCursor + len, cruise });
    sCursor += len;
  });

  // 時刻表（t → s）
  const distanceAt = (t: number): number => {
    let li = legs.findIndex((l) => t < l.t1);
    if (li < 0) li = legs.length - 1;
    return legs[li].s0 + legDistance(resolved[li], Math.min(t, legs[li].t1));
  };
  const timeline: { t: number; s: number }[] = [];
  const steps = Math.round(RIDE_DURATION / TIMELINE_DT);
  for (let k = 0; k <= steps; k++) {
    const t = k * TIMELINE_DT;
    timeline.push({ t: round(t, 4), s: round(distanceAt(t), 5) });
  }
  const sEnd = timeline[timeline.length - 1].s;

  // 距離 s の時刻（高さを当てはめる）。distanceAt は単調なので二分探索
  const timeAt = (s: number): number => {
    let lo = 0;
    let hi = RIDE_DURATION;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (distanceAt(mid) < s) lo = mid;
      else hi = mid;
    }
    return hi;
  };

  // 点列（1m 間隔）と高さ
  const points: Vec3Tuple[] = [];
  const ys: number[] = [];
  let k = 0;
  for (let i = 0; i < pointCount; i++) {
    while (k < path.s.length - 2 && path.s[k + 1] < i) k++;
    const span = path.s[k + 1] - path.s[k];
    const f = span > 0 ? (i - path.s[k]) / span : 0;
    const x = path.x[k] + (path.x[k + 1] - path.x[k]) * f;
    const z = path.z[k] + (path.z[k + 1] - path.z[k]) * f;
    const y = heightAt(timeAt(Math.min(i, sEnd)));
    ys.push(y);
    points.push([round(x, 3), round(y, 3), round(z, 3)]);
  }
  const gentleY = ys.map((y) => round(DOCK_Y + (y - DOCK_Y) * 0.5, 3));

  // 区間（同じ区間の脚をまとめる）
  const sections: { id: SectionId; s0: number; s1: number }[] = [];
  for (const leg of legs) {
    const last = sections[sections.length - 1];
    if (last && last.id === leg.section) last.s1 = round(leg.s1, 5);
    else sections.push({ id: leg.section, s0: round(leg.s0, 5), s1: round(leg.s1, 5) });
  }

  const endX = path.x[Math.min(path.x.length - 1, Math.round(total / STEP))];
  const endZ = path.z[Math.min(path.z.length - 1, Math.round(total / STEP))];
  const data: RideData = {
    version: 1,
    duration: RIDE_DURATION,
    rail: { spacing: 1, points },
    timeline,
    gentleY,
    sections,
  };
  return { data, info: { legs, freeLines: { a, b }, closureGap: Math.hypot(endX, endZ) } };
}

/** レールと時刻表を作る（Blender の書き出しの代わり。scripts/build-ride-data.ts が rail.json に書く） */
export function generateRideData(): RideData {
  return designAll().data;
}

/** 設計の要約（脚ごとの距離と普段の速さ、輪の閉じ具合）。build-ride-data.ts と確認ページが使う */
export function describeDesign(): DesignInfo {
  return designAll().info;
}
