// 夜明けの岸の空と光の時間割（時刻から決める純粋な計算）と、空の色を描くノード。
// 11:00 の膜を抜けると夜明け前の藍と桃色、11:47 の誘導の後 11:48.5 に朝日の縁が水平線に現れ、11:50 に砂浜が一斉に金色に光る。
// 光の強い場面の直前は少し暗くし、明るさの差で驚きを作る（設計書「見せ方のルール」）。
import * as THREE from 'three/webgpu';
import { cameraPosition, exp, float, hash, max, mix, mx_noise_float, positionWorld, pow, smoothstep, step, uniform, vec3 } from 'three/tsl';

/** 朝日の方位: 進行方向（-X）から右へ（度）。blender/scripts/rooms/dawn.py の SUN_AZIMUTH_DEG と揃える */
export const SUN_AZIMUTH_DEG = 30;
/** 朝日の見かけの半径（度）。実際の 3 倍ほど（絵として大きく） */
export const SUN_RADIUS_DEG = 1.5;

const smooth = (e0: number, e1: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return k * k * (3 - 2 * k);
};

/** 朝日の高さ（度。中心）。sunriseT（11:50）に縁が出てから 1 秒半ほどで半分、その後はゆっくり昇る */
export function sunElevationDeg(t: number, sunriseT: number): number {
  const t0 = sunriseT - 1.5; // 縁が水平線に触れる少し前
  if (t <= sunriseT + 4) return -SUN_RADIUS_DEG - 0.3 + 0.45 * (t - t0);
  const e4 = -SUN_RADIUS_DEG - 0.3 + 0.45 * (sunriseT + 4 - t0);
  const k = t - (sunriseT + 4);
  return e4 + 0.15 * k + 0.6 * (1 - Math.exp(-k / 2));
}

/** 時刻ごとの色（sRGB の 16 進）の鍵。間は滑らかに混ぜる */
interface Key {
  readonly t: number;
  readonly zenith: number;
  readonly horizonSun: number;
  readonly horizonAway: number;
  readonly water: number;
  readonly hill: number;
}

/** sunriseT からの秒で書く */
const KEYS: readonly Key[] = [
  { t: -50, zenith: 0x161a44, horizonSun: 0x6e5f96, horizonAway: 0x3c4074, water: 0x0d1128, hill: 0x221f3e },
  { t: -25, zenith: 0x1d2352, horizonSun: 0xa8739a, horizonAway: 0x56558a, water: 0x10152e, hill: 0x2c284a },
  { t: -6, zenith: 0x20275a, horizonSun: 0xcf8584, horizonAway: 0x6a6496, water: 0x141932, hill: 0x34304f },
  { t: 0, zenith: 0x2f3c74, horizonSun: 0xee9a6a, horizonAway: 0x9a86a8, water: 0x1c2240, hill: 0x4a4060 },
  { t: 3, zenith: 0x4a64a4, horizonSun: 0xf6ae72, horizonAway: 0xd7a69e, water: 0x23294a, hill: 0x67566e },
  { t: 15, zenith: 0x6585c0, horizonSun: 0xf8c286, horizonAway: 0xecc2ae, water: 0x2a3456, hill: 0x806e84 },
  { t: 45, zenith: 0x7ea2d4, horizonSun: 0xfbd6a8, horizonAway: 0xf0d4c2, water: 0x34446a, hill: 0x928ea4 },
];

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

function keyColor(t: number, sunriseT: number, pick: (k: Key) => number, out: THREE.Color): THREE.Color {
  const x = t - sunriseT;
  let i = 0;
  while (i < KEYS.length - 1 && KEYS[i + 1].t <= x) i++;
  const a = KEYS[i];
  const b = KEYS[Math.min(i + 1, KEYS.length - 1)];
  const k = b.t === a.t ? 0 : smooth(a.t, b.t, x);
  // 線形の光で混ぜる（sRGB のまま混ぜると中間が濁る）
  tmpA.setHex(pick(a), THREE.SRGBColorSpace);
  tmpB.setHex(pick(b), THREE.SRGBColorSpace);
  return out.copy(tmpA).lerp(tmpB, k);
}

/** ある時刻の夜明けの光（毎フレーム書き換える。確保しない） */
export interface DawnState {
  /** 線形の色 */
  readonly zenith: THREE.Color;
  readonly horizonSun: THREE.Color;
  readonly horizonAway: THREE.Color;
  readonly water: THREE.Color;
  readonly hill: THREE.Color;
  readonly sunColor: THREE.Color;
  /** 部屋の空気の背景（地平の平均。sRGB の 16 進で比べる） */
  readonly background: THREE.Color;
  sunElevationDeg: number;
  /** 太陽の円盤の明るさ（HDR） */
  sunDisc: number;
  /** 太陽のまわりの光のにじみ */
  glow: number;
  /** 空の星（夜の名残） */
  stars: number;
  /** 砂浜に当たる朝日（焼いた朝日のライトマップの重み） */
  sunOnSand: number;
  /** 砂浜に当たる空の光（焼いた空の光のライトマップの重み） */
  skyOnSand: number;
  /** 砂のきらめき（11:50 に一斉に金色） */
  sparkle: number;
  /** 標柱の灯（夜明けとともに消える） */
  lamps: number;
  exposure: number;
}

export function createDawnState(): DawnState {
  return {
    zenith: new THREE.Color(),
    horizonSun: new THREE.Color(),
    horizonAway: new THREE.Color(),
    water: new THREE.Color(),
    hill: new THREE.Color(),
    sunColor: new THREE.Color(),
    background: new THREE.Color(),
    sunElevationDeg: 0,
    sunDisc: 0,
    glow: 0,
    stars: 0,
    sunOnSand: 0,
    skyOnSand: 0,
    sparkle: 0,
    lamps: 0,
    exposure: 1,
  };
}

/**
 * 時刻 t の夜明けの光。sunriseT は 11:50（MOMENT_BARS.dawnSunrise）。
 * 光の点滅を抑えるモードでは、朝日と砂のきらめきを弱め、立ち上がりをゆっくりにする。
 */
export function dawnAt(t: number, sunriseT: number, reducedFlash: boolean, out: DawnState): DawnState {
  keyColor(t, sunriseT, (k) => k.zenith, out.zenith);
  keyColor(t, sunriseT, (k) => k.horizonSun, out.horizonSun);
  keyColor(t, sunriseT, (k) => k.horizonAway, out.horizonAway);
  keyColor(t, sunriseT, (k) => k.water, out.water);
  keyColor(t, sunriseT, (k) => k.hill, out.hill);
  out.background.copy(out.horizonSun).lerp(out.horizonAway, 0.5);
  const e = sunElevationDeg(t, sunriseT);
  out.sunElevationDeg = e;
  // 朝日の色: 昇り始めは濃い金と桃、高くなるにつれて白い金へ
  out.sunColor.setRGB(1.0, 0.62 + 0.25 * smooth(-1, 6, e), 0.36 + 0.4 * smooth(-1, 7, e), THREE.LinearSRGBColorSpace);
  const flash = reducedFlash ? 0.55 : 1;
  out.sunDisc = 16 * flash * smooth(-SUN_RADIUS_DEG - 0.2, SUN_RADIUS_DEG, e);
  out.glow = (0.22 + 0.45 * smooth(sunriseT - 50, sunriseT - 2, t) + 0.55 * smooth(sunriseT - 1, sunriseT + 3, t) - 0.25 * smooth(sunriseT + 4, sunriseT + 30, t)) * (reducedFlash ? 0.8 : 1);
  out.stars = 1 - smooth(sunriseT - 50, sunriseT - 20, t);
  const rise = reducedFlash ? 4 : 3;
  out.sunOnSand = smooth(sunriseT - 1.2, sunriseT + rise, t) * (0.8 + 0.2 * smooth(sunriseT + 3, sunriseT + 30, t)) * (reducedFlash ? 0.8 : 1);
  out.skyOnSand = 0.18 + 0.2 * smooth(sunriseT - 50, sunriseT - 8, t) + 0.35 * smooth(sunriseT - 1, sunriseT + 6, t);
  // 砂のきらめき: 縁が出た瞬間に一斉に金色。光の点滅を抑えるモードではゆっくり、控えめに
  if (reducedFlash) out.sparkle = 0.45 * smooth(sunriseT - 0.5, sunriseT + 4, t) * (1 - 0.3 * smooth(sunriseT + 6, sunriseT + 16, t));
  else out.sparkle = smooth(sunriseT - 0.4, sunriseT + 0.6, t) * (1 - 0.45 * smooth(sunriseT + 1.5, sunriseT + 7, t));
  out.lamps = 1 - smooth(sunriseT + 2, sunriseT + 16, t);
  // 朝日の直前に少し暗く（11:44〜11:48）、昇ると明るく
  out.exposure = 1.0 - 0.07 * smooth(sunriseT - 8, sunriseT - 2, t) + 0.12 * smooth(sunriseT - 1, sunriseT + 6, t);
  return out;
}

/** 空のノードのつまみ（空の板と、低品質の水面の映り込みで共有する） */
export interface SkyUniforms {
  readonly zenith: THREE.UniformNode<'color', THREE.Color>;
  readonly horizonSun: THREE.UniformNode<'color', THREE.Color>;
  readonly horizonAway: THREE.UniformNode<'color', THREE.Color>;
  readonly sunColor: THREE.UniformNode<'color', THREE.Color>;
  readonly sunDir: THREE.UniformNode<'vec3', THREE.Vector3>;
  readonly sunDisc: THREE.UniformNode<'float', number>;
  readonly glow: THREE.UniformNode<'float', number>;
  readonly stars: THREE.UniformNode<'float', number>;
  readonly time: THREE.UniformNode<'float', number>;
}

export function createSkyUniforms(): SkyUniforms {
  return {
    zenith: uniform(new THREE.Color()),
    horizonSun: uniform(new THREE.Color()),
    horizonAway: uniform(new THREE.Color()),
    sunColor: uniform(new THREE.Color()),
    sunDir: uniform(new THREE.Vector3(-1, 0, 0)),
    sunDisc: uniform(0),
    glow: uniform(0),
    stars: uniform(0),
    time: uniform(0),
  };
}

/** 朝日の向き（水平の単位ベクトル。three の座標） */
export function sunHorizontal(out = new THREE.Vector3()): THREE.Vector3 {
  const a = (SUN_AZIMUTH_DEG * Math.PI) / 180;
  return out.set(-Math.cos(a), 0, -Math.sin(a));
}

export function sunDirection(elevationDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const e = (elevationDeg * Math.PI) / 180;
  sunHorizontal(out).multiplyScalar(Math.cos(e));
  out.y = Math.sin(e);
  return out;
}

/**
 * 向き dir（単位ベクトル）の空の色（線形、HDR）。地平は太陽の側ほど暖かく、天頂へ藍から青へ。
 * 朝日の円盤と光のにじみ、低い横雲（clouds）、夜の名残の星。
 */
export function skyColorNode(dir: THREE.Node<'vec3'>, u: SkyUniforms, opts: { clouds: boolean }): THREE.Node<'vec3'> {
  const el = dir.y;
  const flat = vec3(dir.x, 0, dir.z).normalize();
  const sunFlat = vec3(u.sunDir.x, 0, u.sunDir.z).normalize();
  const toward = flat.dot(sunFlat).mul(0.5).add(0.5); // 0 = 太陽の反対、1 = 太陽の側
  const horizon = mix(u.horizonAway, u.horizonSun, pow(toward, 2.2));
  const up = pow(max(el, 0), 0.45);
  let col: THREE.Node<'vec3'> = mix(horizon, u.zenith, up.clamp(0, 1));
  // 太陽のまわりのにじみ（地平に沿って広く、太陽の近くで強く）
  const cosA = dir.dot(u.sunDir).clamp(-1, 1);
  const ang = cosA.acos();
  const near = exp(ang.mul(-9)).mul(0.9).add(exp(ang.mul(-2.4)).mul(0.25));
  const band = exp(el.abs().mul(-14)).mul(pow(toward, 5)).mul(0.55);
  col = col.add(u.sunColor.mul(near.add(band)).mul(u.glow));
  if (opts.clouds) {
    // 低い横雲（雲の平面に写した位置のノイズ）。夜明け前は藍の影、太陽の側は下から桃と金に照らされる
    const p = flat.xz.div(max(el, 0.02).add(0.04)).mul(0.22);
    const n = mx_noise_float(vec3(p.x, p.y.mul(1.6), u.time.mul(0.003))).mul(0.65).add(mx_noise_float(vec3(p.x.mul(2.7), p.y.mul(3.9), 5.3)).mul(0.35));
    const dens = smoothstep(0.12, 0.75, n).mul(smoothstep(0.012, 0.06, el)).mul(float(1).sub(smoothstep(0.14, 0.36, el)));
    const lit = pow(toward, 2.5);
    const shade = mix(mix(u.zenith, u.horizonAway, 0.4).mul(0.8), u.horizonSun.mul(0.95), lit).add(u.sunColor.mul(near).mul(u.glow).mul(0.35));
    col = mix(col, shade, dens.mul(0.42));
  }
  // 朝日の円盤（水平線の下は水面が隠す）
  const r = (SUN_RADIUS_DEG * Math.PI) / 180;
  const disc = smoothstep(r * 1.03, r * 0.9, ang).mul(step(-0.0005, el));
  col = col.add(u.sunColor.mul(disc).mul(u.sunDisc));
  // 夜の名残の星（天頂の側だけ）
  const g = dir.mul(170);
  const cell = g.floor();
  const fr = g.sub(cell).sub(0.5);
  const seed = cell.dot(vec3(1, 157, 113)).add(1e6); // hash は符号なし整数で計算するので正にする
  const star = step(0.985, hash(seed)).mul(exp(fr.dot(fr).mul(-30))).mul(smoothstep(0.08, 0.4, el));
  col = col.add(vec3(0.9, 0.92, 1.0).mul(star).mul(u.stars).mul(0.9));
  return col;
}

/** 目からの向き（空の板の上の点から） */
export function viewDirectionNode(): THREE.Node<'vec3'> {
  return positionWorld.sub(cameraPosition).normalize();
}
