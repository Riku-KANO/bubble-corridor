// ガラスの材質ライブラリ。案1と共有する。three/webgpu の NodeMaterial（TSL）で作り、
// WebGPU・WebGL2・VR の3つの描画経路で同じ見た目にする。
// 透過（transmission）は重く、重なると破綻するので使わない。縁の反射（フレネル）と薄膜干渉の虹色で
// 「ガラスらしさ」を出す（設計書「描画の工夫」）。
//
// 組み立て:
//   ・視線と法線の角度 nv から、縁の強さ（フレネル）と光が通る道のり（厚み）を出す。
//   ・不透明度 A は「材質の opacity を、道のりに応じて縁ほど厚くしたもの」（ランベルト・ベールの吸収の近似）。
//   ・ブレンドは「背景 × (1 - A) ＋ 出力」（premultiplied）。出力（emissive）に入れた縁の反射・虹色・波紋は
//     A に薄められず、そのままの明るさで乗る。色ガラスの色は tint × A として足すので、普通の半透明と同じ見え方。
//   ・虹色と縁の反射は「縁で見せる」。正面（真正面から見たところ）はごく薄く（`face`）。泡の内側から見た視界の中央は澄んだまま。
//   ・動く光源は持たない。反射は「空と地面のグラデーション」と、低い光の2つのハイライトを視線の反射方向だけで描く
//     （色・向きは setGlassLighting で部屋ごとに変える。scene.environment があればこの擬似反射は弱め、環境画像の反射が主になる）。
//   ・scene.fog の中では、霧の色に A を掛けて混ぜる（premultiplied のまま霧に溶ける）。
//   ・tier で計算を減らす: high=ノイズ2段の虹色の流れ・曇りのざらつき、medium=ノイズ1段、low=サイン波だけ。
//
// 触れたときの反応（縁の光・波紋・時刻）はすべて uniform なので、次のフレームから即座に効く（シェーダを作り直さない）。
//
// 作るコスト: 材質1つの組み立ては数 ms かかる（200 個で約 1 秒止まる）。飾りのガラスは `sharedGlass` で共有し、
// 前の部屋にいる間に `renderer.compileAsync` で先にコンパイルしておく（src/core/README.md）。
import * as THREE from 'three/webgpu';
import {
  cameraViewMatrix,
  cos,
  dot,
  exp,
  float,
  length,
  materialColor,
  materialEmissive,
  materialOpacity,
  max,
  mix,
  mx_noise_float,
  normalView,
  normalWorld,
  output,
  positionLocal,
  positionView,
  positionViewDirection,
  positionWorld,
  pow,
  reflectVector,
  saturate,
  select,
  sin,
  smoothstep,
  specularColor,
  specularColorBlended,
  step,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import type { QualityTier } from '../quality';

/** ガラスの種類（設計書のアートディレクションの「主なガラス」） */
export type GlassKind =
  | 'clear' // 透明
  | 'frosted' // 曇り
  | 'tinted' // 色ガラス
  | 'iridescent' // 薄膜の虹色（泡、膜、球殻）
  | 'milky' // 乳白
  | 'mirror'; // 鏡（万華鏡）

export interface GlassParams {
  readonly color?: THREE.ColorRepresentation;
  /** 不透明度（0〜1） */
  readonly opacity?: number;
  /** 表面の粗さ（0〜1） */
  readonly roughness?: number;
  /** 薄膜の虹色の強さ（0〜1） */
  readonly iridescence?: number;
  /** 内側から光る色（星、灯り）。焼き込み前提なので動く光源の代わりに使う */
  readonly emissive?: THREE.ColorRepresentation;
  readonly emissiveIntensity?: number;
  /** 縁の反射の強さ（0〜1） */
  readonly rim?: number;
  /** 両面を描くか（泡の内側から見る殻など） */
  readonly doubleSided?: boolean;
  /**
   * 正面（真正面から見たところ）の虹色の強さ（0〜1）。既定は 0.01（縁だけで見せる。泡の内側から見ても視界の中央は澄んだまま）。
   * 虹色の膜の板（部屋の境目の膜）のように、面全体に色を出したいときだけ上げる。
   * 両面（doubleSided）の物は、カメラがその境界球の内側に入ると「殻の内側」として扱い、視界の外周だけにかすかに虹色を出す
   * （正面は無色、時刻で全体の色が回らない、光のハイライトはほぼ消す）。両面で面全体の色を保ちたい膜は face を上げる（上げた分だけ内側扱いにならない）。
   */
  readonly face?: number;
}

/** ガラスの材質と、触れたときの反応を動かすつまみ */
export interface GlassHandle {
  readonly material: THREE.Material;
  /** 縁の光（0〜1）。触れられる物に近づいたとき */
  setHighlight(level: number): void;
  /**
   * 触れたときの光の波紋。now は秒（波紋は約0.8秒で消える）。
   * origin（世界座標の触れた点）を渡すと、その点から面に沿って広がる。省くと、見えている面の中心から縁へ広がる
   * （カメラが球殻の内側にいるときは、視線の正面から広がる）。
   */
  pulse(now: number, origin?: THREE.Vector3): void;
  /** 毎フレームの時刻（秒）。虹色の流れと波紋に使う */
  setTime(now: number): void;
  dispose(): void;
}

export interface GlassOptions {
  /** 省くと setDefaultGlassTier の値（既定 'medium'） */
  readonly tier?: QualityTier;
}

/** 擬似反射の照明（部屋の空気に合わせて変える）。色は CSS の色など、向きは世界座標 */
export interface GlassLighting {
  /** 上向きの面が映す色（空） */
  readonly sky: THREE.ColorRepresentation;
  /** 下向きの面が映す色（地面） */
  readonly ground: THREE.ColorRepresentation;
  /** ハイライトを作る光の来る向き（世界座標。正規化しなくてよい） */
  readonly keyDir: THREE.Vector3Like;
  readonly keyColor: THREE.ColorRepresentation;
  /** ハイライトの強さの倍率（0 で消す） */
  readonly keyIntensity: number;
  /** scene.environment があるとき、擬似反射に掛ける倍率（0〜1）。環境画像の反射が主になるよう弱める */
  readonly envReflection: number;
}

/** 波紋が消えるまでの秒 */
const PULSE_SEC = 0.8;

interface Spec {
  readonly color: number;
  readonly opacity: number;
  readonly roughness: number;
  readonly metalness: number;
  /** 縁の反射の強さの既定 */
  readonly rim: number;
  /** フレネルの鋭さ（大きいほど縁だけが光る） */
  readonly power: number;
  /** 縁ほど厚く見える度合い（0〜1） */
  readonly thickness: number;
  /** 薄膜の虹色の強さの既定 */
  readonly film: number;
  /** 内側のぼんやりした光（曇り・乳白が光を散らす） */
  readonly glow: number;
  /** 曇りのざらつき */
  readonly grain: number;
  /** 縁ほど薄く（透けて）見せる度合い（乳白の石のように、縁は光を通す）。0〜1 */
  readonly edgeFade: number;
  /** 正面の虹色の強さの既定 */
  readonly face: number;
  /** 薄い殻か（色は縁だけで、正面はほぼ無色。透明・虹色） */
  readonly thin: boolean;
}

const SPECS: Record<GlassKind, Spec> = {
  clear: { color: 0xd8ecff, opacity: 0.05, roughness: 0.04, metalness: 0, rim: 0.9, power: 3.2, thickness: 0.9, film: 0.12, glow: 0, grain: 0, edgeFade: 0, face: 0.01, thin: true },
  frosted: { color: 0xdfeaf6, opacity: 0.2, roughness: 0.6, metalness: 0, rim: 0.5, power: 1.6, thickness: 0.5, film: 0, glow: 0.3, grain: 1, edgeFade: 0, face: 0.01, thin: false },
  tinted: { color: 0x86d1b4, opacity: 0.42, roughness: 0.06, metalness: 0, rim: 0.7, power: 3.2, thickness: 1, film: 0.05, glow: 0, grain: 0, edgeFade: 0, face: 0.01, thin: false },
  iridescent: { color: 0xeaf4ff, opacity: 0.04, roughness: 0.03, metalness: 0, rim: 0.8, power: 2.6, thickness: 0.6, film: 1, glow: 0, grain: 0, edgeFade: 0, face: 0.01, thin: true },
  milky: { color: 0xf5eee2, opacity: 0.62, roughness: 0.28, metalness: 0, rim: 0.4, power: 2.4, thickness: 0.1, film: 0.1, glow: 0.3, grain: 0, edgeFade: 1, face: 0.01, thin: false },
  mirror: { color: 0xeef3ff, opacity: 1, roughness: 0.04, metalness: 1, rim: 0.2, power: 3, thickness: 0, film: 0, glow: 0, grain: 0, edgeFade: 0, face: 0.01, thin: false },
};

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

// ── 全材質で共有するつまみ（モジュール単位の uniform。変えると、作った材質すべてに次のフレームから効く） ──

/** 既定の擬似照明: 夜明けの空と地面、低い光（案2の乗り場・温室向き。部屋が変わるときは setGlassLighting で変える） */
const DEFAULT_LIGHTING = {
  sky: new THREE.Color().setRGB(0.5, 0.72, 1.0, THREE.LinearSRGBColorSpace),
  ground: new THREE.Color().setRGB(1.0, 0.78, 0.62, THREE.LinearSRGBColorSpace),
  keyDir: new THREE.Vector3(-0.35, 0.5, 0.79).normalize(),
  keyColor: new THREE.Color().setRGB(1.0, 0.96, 0.9, THREE.LinearSRGBColorSpace),
  keyIntensity: 1,
  envReflection: 0.4,
};
const uSky = uniform(DEFAULT_LIGHTING.sky.clone());
const uGround = uniform(DEFAULT_LIGHTING.ground.clone());
const uKeyDir = uniform(DEFAULT_LIGHTING.keyDir.clone());
const uKeyColor = uniform(DEFAULT_LIGHTING.keyColor.clone());
const uKeyIntensity = uniform(DEFAULT_LIGHTING.keyIntensity);
const uEnvReflection = uniform(DEFAULT_LIGHTING.envReflection);
/** 描くシーンに環境画像があるか（0/1）。描く直前にシーンから読む */
const uHasEnv = uniform(0).onObjectUpdate(({ scene }, self) => {
  const sc = scene as THREE.Scene | undefined;
  self.value = sc && (sc.environment || (sc as THREE.Scene & { environmentNode?: unknown }).environmentNode) ? 1 : 0;
});
/** 波紋の中心の閃光の強さの倍率（0〜1）。光の点滅を抑えるモード用 */
const uFlash = uniform(1);
/** 擬似反射に掛ける倍率（環境画像があれば弱める） */
const fakeScale = mix(float(1), uEnvReflection, uHasEnv);

/**
 * 擬似反射の照明を変える（部屋の空気に合わせる。例: 天球は藍と星の白金、温室は若葉と朝日）。
 * 指定したものだけ変わり、作った材質すべてに次のフレームから効く。
 */
export function setGlassLighting(l: Partial<GlassLighting>): void {
  if (l.sky !== undefined) (uSky.value as THREE.Color).set(l.sky);
  if (l.ground !== undefined) (uGround.value as THREE.Color).set(l.ground);
  if (l.keyDir !== undefined) {
    const d = new THREE.Vector3(l.keyDir.x, l.keyDir.y, l.keyDir.z);
    if (d.lengthSq() > 1e-9) (uKeyDir.value as THREE.Vector3).copy(d.normalize());
  }
  if (l.keyColor !== undefined) (uKeyColor.value as THREE.Color).set(l.keyColor);
  if (l.keyIntensity !== undefined) uKeyIntensity.value = Math.max(0, Number.isFinite(l.keyIntensity) ? l.keyIntensity : 1);
  if (l.envReflection !== undefined) uEnvReflection.value = clamp01(l.envReflection);
}

/** 擬似照明を既定（夜明け）へ戻す */
export function resetGlassLighting(): void {
  (uSky.value as THREE.Color).copy(DEFAULT_LIGHTING.sky);
  (uGround.value as THREE.Color).copy(DEFAULT_LIGHTING.ground);
  (uKeyDir.value as THREE.Vector3).copy(DEFAULT_LIGHTING.keyDir);
  (uKeyColor.value as THREE.Color).copy(DEFAULT_LIGHTING.keyColor);
  uKeyIntensity.value = DEFAULT_LIGHTING.keyIntensity;
  uEnvReflection.value = DEFAULT_LIGHTING.envReflection;
}

/**
 * 波紋の中心の閃光の強さの倍率（0〜1、既定 1）。光の点滅を抑えるモードで下げる（0 で波紋を出さない）。
 * 触れた反応は光だけでも分かるようにする必要があるので、0 にはせず 0.3 前後を勧める。
 */
export function setGlassFlashScale(scale: number): void {
  uFlash.value = clamp01(scale);
}

let defaultTier: QualityTier = 'medium';
/** createGlass・sharedGlass で tier を省いたときの値。アプリが起動時に quality の結果で一度決める */
export function setDefaultGlassTier(tier: QualityTier): void {
  defaultTier = tier;
}
export function getDefaultGlassTier(): QualityTier {
  return defaultTier;
}

/** 毎フレームの計算で使い回す（物ごとに new しない） */
const _center = new THREE.Vector3();

/**
 * ガラスの材質。three の霧（scene.fog）の混ぜ方だけ差し替える。
 * 標準は mix(rgb, 霧の色, f) だが、premultiplied のブレンド（背景 × (1-A) ＋ rgb）では A が掛からず、
 * 遠くで「霧の色 × (2-A)」になって霧より明るく浮く。mix(rgb, 霧の色 × A, f) にすれば f=1 で背景（霧の色）に溶ける。
 */
class GlassNodeMaterial extends THREE.MeshStandardNodeMaterial {
  /**
   * 正面（垂直に当たる光）の鏡面反射の強さの倍率（0〜1）。標準は誘電体の 0.04 だが、そのまま環境画像を映すと、
   * 泡の内側から見た視界の全体に 4% の薄いヴェールが載る。縁（F90）はそのまま 1 にして、縁の反射は残す。
   */
  centerSpecular = 1;

  // three r186 の MeshStandardNodeMaterial.setupSpecular: specularColor=0.04、specularColorBlended=mix(0.04, 拡散色, 金属度)、F90=1。
  // 自前で組み直さず、標準の結果に倍率を掛けるだけにする（three の版が変わっても標準の変更に追従する）。
  override setupSpecular() {
    super.setupSpecular();
    if (this.centerSpecular !== 1) {
      specularColor.assign(specularColor.mul(this.centerSpecular));
      specularColorBlended.assign(specularColorBlended.mul(this.centerSpecular));
    }
  }

  /**
   * three r186 の NodeMaterial.setupFog は、`builder.fogNode`（scene.fog から作られる、または scene.fogNode）を
   * output（vec4）に当てて F(x) = mix(x.rgb, 霧の色, f) を得る。ガラスの色は premultiplied（rgb は A を掛けた後）なので、
   * 欲しいのは G = rgb × (1-f) + 霧の色 × f × A。F は x.rgb について線形なので、A で割った色に当てて A を掛け直す:
   *   G = F(rgb / A) × A
   * 霧の中身（Fog・FogExp2・独自の fogNode）には依らない。fogNode は 1 回だけ評価する
   * （同じノードを2回使うと、three はその計算を一時変数にまとめて使い回すので、2回目に output を変えても値が変わらない）。
   */
  override setupFog(builder: Parameters<THREE.MeshStandardNodeMaterial['setupFog']>[0], outputNode: Parameters<THREE.MeshStandardNodeMaterial['setupFog']>[1]) {
    const fogNode = (builder as unknown as { fogNode?: THREE.Node<'vec4'> | null }).fogNode;
    if (!fogNode) return outputNode;
    const out = outputNode as THREE.Node<'vec4'>;
    // A が 0 に近い所（縁の反射だけの所）でも割り算が壊れないよう下限を置く（掛け直すので結果はほぼ変わらない）
    const a = out.a.max(1e-3);
    output.assign(vec4(out.rgb.div(a), out.a));
    const fogged = fogNode.toVar();
    return vec4(fogged.rgb.mul(a), out.a);
  }
}

export function createGlass(kind: GlassKind, params: GlassParams = {}, opts: GlassOptions = {}): GlassHandle {
  const tier: QualityTier = opts.tier ?? defaultTier;
  const spec = SPECS[kind];
  const isMirror = kind === 'mirror';
  const rimStrength = clamp01(params.rim ?? spec.rim);
  const filmStrength = clamp01(params.iridescence ?? spec.film);
  const face = clamp01(params.face ?? spec.face);

  const material = new GlassNodeMaterial({
    color: params.color ?? spec.color,
    roughness: params.roughness ?? spec.roughness,
    metalness: spec.metalness,
    transparent: !isMirror,
    opacity: params.opacity ?? spec.opacity,
    emissive: params.emissive ?? 0x000000,
    emissiveIntensity: params.emissiveIntensity ?? (params.emissive === undefined ? 0 : 1),
    side: params.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    // 奥のガラスを隠さない。鏡は不透明なので深度を書く
    depthWrite: isMirror,
  });

  // 正面の反射は face に合わせて弱める（膜の板のように face を上げたものは標準に近づく）。鏡は標準のまま
  material.centerSpecular = isMirror ? 1 : 0.2 + 0.8 * face;

  if (!isMirror) {
    // ガラスは光を拡散させない（拡散反射があると環境光で白く濁る）。色は emissive の tint × A で出すので、
    // 標準の材質の拡散だけ黒にする（material.color は tint の元として残る。鏡面反射は誘電体の 0.04 のまま）
    material.colorNode = vec4(0, 0, 0, 1);
    // 背景 × (1 - A) ＋ 出力。反射と虹色が A に薄められないようにする
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
  }

  // ── つまみ（uniform） ──
  const uTime = uniform(0);
  const uHighlight = uniform(0);
  /** 波紋が始まった時刻。遠い過去にしておくと出ない */
  const uPulseStart = uniform(-1e4);
  /** 触れた点（世界座標）。w が 1 のとき有効 */
  const uPulseOrigin = uniform(new THREE.Vector4());
  /** 描く物の大きさ（世界座標の中心と半径）。物ごとに描く直前に更新する。波紋の広がりの目安 */
  const uBounds = uniform(new THREE.Vector4(0, 0, 0, 1)).onObjectUpdate(({ object }, self) => {
    if (!object) return;
    const geometry = (object as THREE.Mesh).geometry;
    if (!geometry) return;
    if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
    const s = geometry.boundingSphere;
    if (!s) return;
    const v = self.value as THREE.Vector4;
    _center.copy(s.center).applyMatrix4(object.matrixWorld);
    v.set(_center.x, _center.y, _center.z, s.radius * object.matrixWorld.getMaxScaleOnAxis());
  });

  // ── 視線と法線の角度 ──
  const nv = saturate(dot(normalView, positionViewDirection).abs());
  const edge = float(1).sub(nv);
  const fres = pow(edge, spec.power);
  /** 光が通る道のり。真正面で 1、縁で大きい */
  const path = float(1).div(max(nv, 0.18));

  // ── 不透明度 A ──
  const base = materialOpacity.clamp(0, 0.999);
  let alpha = float(1).sub(pow(float(1).sub(base), float(1).add(path.sub(1).mul(spec.thickness))));
  if (spec.grain > 0 && tier !== 'low') {
    // 曇りガラスのざらつき: 細かいノイズで濃さをわずかに揺らす（回すとかすかに瞬くので控えめ）
    alpha = alpha.add(mx_noise_float(positionLocal.mul(40)).mul(0.03 * spec.grain));
  }
  if (spec.edgeFade > 0) alpha = alpha.mul(mix(float(1), nv.mul(0.45).add(0.55), spec.edgeFade));
  alpha = alpha.add(uHighlight.mul(fres).mul(0.12));

  // ── カメラと物の位置関係（波紋と、殻の内側の見え方で使う。どれも 0 で割らない） ──
  const radius = uBounds.w.max(1e-4);
  const centerView = cameraViewMatrix.mul(vec4(uBounds.xyz, 1)).xyz;
  const centerZ = centerView.z.negate(); // 中心の奥行き（前が正）
  const camDist = length(centerView);
  /** 視線の正面からの角度の正弦（0 = 画面の中央、視野の端で 0.6〜0.9）。画面上の半径の代わり */
  const gazeR = length(positionView.xy).div(length(positionView).max(1e-4));
  const cameraOutside = step(radius.mul(1.05), camDist).mul(step(radius.mul(0.25), centerZ));
  /**
   * カメラが殻の内側にいる度合い（0〜1。境界球の少し内外で滑らかに）。両面の殻（ゴンドラ、天球）だけが対象。
   * 内側では視界のどこでも nv ≈ 1（縁がない）ので、縁の虹色・光のハイライトを nv ではなく画面上の半径で測る。
   * face を上げた物（膜の板）は内側扱いにしない。
   */
  const insideW: THREE.Node<'float'> = params.doubleSided ? float(1).sub(smoothstep(radius.mul(0.9), radius.mul(1.1), camDist)).mul(1 - face) : float(0);

  // ── 反射（視線の反射方向だけで描く。照明は setGlassLighting の共有 uniform） ──
  const refl = reflectVector;
  const rimTint = mix(uGround, uSky, smoothstep(-0.45, 0.55, refl.y));
  const keyDot = max(dot(refl, uKeyDir), 0);
  const roughSoft = 1 - Math.min(1, (params.roughness ?? spec.roughness) * 1.4); // 粗いほどハイライトは広く弱い
  const keyBroad = pow(keyDot, 9).mul(0.22 * (1.2 - roughSoft));
  const keySharp = pow(keyDot, 170).mul(1.7 * roughSoft * roughSoft);
  const reflection = rimTint
    .mul(fres)
    .mul(rimStrength * 1.25)
    // 殻の内側では、反射方向が「視線の真後ろ」になり、広いハイライトが視界の下などに大きな白い塊として出る。ほぼ消す
    .add(uKeyColor.mul(keyBroad.add(keySharp)).mul(uKeyIntensity).mul(0.35 + rimStrength).mul(mix(float(1), float(0.1), insideW)))
    .mul(fakeScale);

  // ── 薄膜干渉の虹色 ──
  let film: THREE.Node<'vec3'> = vec3(0);
  if (filmStrength > 0.001) {
    // 厚み（光が通る道のり）: 外から見るときは視線と法線の角度から。殻の内側では画面上の半径から（視界の外周ほど厚く見える）
    const thick = mix(path.sub(1).clamp(0, 2.6), gazeR.mul(1.6), insideW);
    // 膜の厚みのむら: 渦のように流れる。low はノイズを使わずサイン波だけ
    const drift = vec3(0, uTime.mul(-0.045), uTime.mul(0.03));
    let swirl: THREE.Node<'float'>;
    if (tier === 'low') {
      swirl = sin(positionLocal.x.mul(2.3).add(positionLocal.y.mul(1.7)).add(uTime.mul(0.32)))
        .mul(0.5)
        .add(sin(positionLocal.z.mul(3.1).sub(positionLocal.y.mul(1.3)).sub(uTime.mul(0.21))).mul(0.5));
    } else if (tier === 'medium') {
      swirl = mx_noise_float(positionLocal.mul(2.1).add(drift));
    } else {
      swirl = mx_noise_float(positionLocal.mul(2.1).add(drift)).mul(0.65).add(mx_noise_float(positionLocal.mul(4.7).add(drift.mul(1.8))).mul(0.35));
    }
    // 時刻で全体の色が回る項は、外から見るときだけ（殻の内側では視界の全体がほぼ一様なので、全体の色が時間で移ってしまう）
    const phase = thick.mul(0.5).add(swirl.mul(0.34)).add(uTime.mul(0.02).mul(float(1).sub(insideW)));
    const wave = vec3(0, 0.33, 0.67).add(phase);
    const rainbow = vec3(0.5).add(vec3(0.5).mul(cos(wave.mul(6.28318))));
    // 色がきつすぎないよう白へ寄せる
    const pastel = mix(vec3(0.72), rainbow, 0.78);
    // 縁ほど強く、正面は face だけ（視界の中央を澄んだままにする）。
    // 殻の内側では、視界の外周（中央から約 27° の外）だけにかすかに出し、中央は 0
    const amountOut = float(face).add(edge.mul(1.2 * (1 - face)));
    const amountIn = smoothstep(0.5, 0.9, gazeR).mul(0.012);
    const amount = mix(amountOut, amountIn, insideW);
    film = pastel.mul(filmStrength).mul(amount);
    alpha = alpha.add(amount.mul(0.05 * filmStrength));
  }

  // ── 内側のぼんやりした光（曇り・乳白が光を散らす） ──
  // 上は空の冷たい色、下は地面の暖かい色を受けて、丸みが出る（空と地面の色は擬似照明と同じ）
  const hemi = mix(uGround.mul(0.5).add(0.5), uSky.mul(0.5).add(0.5), normalWorld.y.mul(0.5).add(0.5));
  const glow = spec.glow > 0 ? materialColor.rgb.mul(hemi).mul(spec.glow).mul(float(0.5).add(nv.mul(0.5))) : vec3(0);

  // ── 縁の光（触れられる物に近づいたとき） ──
  const highlight = vec3(0.92, 0.97, 1.0).mul(uHighlight).mul(fres.mul(1.1).add(0.035));

  // ── 触れたときの波紋 ──
  const elapsed = uTime.sub(uPulseStart);
  const live = elapsed.greaterThanEqual(0).and(elapsed.lessThan(PULSE_SEC));
  const p = saturate(elapsed.div(PULSE_SEC));
  // 距離の測り方（どれも 0 で割らない。NaN が出ると emissive 全体が消えるため）:
  //  ・触れた点があれば世界座標でそこから
  //  ・なければ、カメラが物の外にあるとき（中心が前にあるとき）は見えている面の中心から（画面の上で測る）
  //  ・カメラが球殻の内側にいる、または中心がカメラの横・後ろのときは、視線の正面から外へ
  const centerZSafe = centerZ.max(1e-3);
  const fragZSafe = positionView.z.negate().max(1e-4);
  const projected = length(positionView.xy.div(fragZSafe).sub(centerView.xy.div(centerZSafe))).div(radius.div(centerZSafe));
  const gaze = gazeR.mul(1.5);
  const dSurface = mix(gaze, projected, cameraOutside);
  const dWorld = length(positionWorld.sub(uPulseOrigin.xyz)).div(radius.mul(1.1));
  const d = mix(dSurface, dWorld, uPulseOrigin.w);
  // 広がり方は最初が速く、だんだんゆっくり（水面の波紋）。縁を越えて抜けきる
  const front = float(1).sub(float(1).sub(p).mul(float(1).sub(p))).mul(1.7);
  const q = d.sub(front).div(0.11); // 負になりうる。pow の底に負を渡すと未定義なので、2乗は掛け算で
  const ring = exp(q.mul(q).negate());
  const trail = float(1).sub(smoothstep(front.sub(0.55), front, d)).mul(0.07);
  const fade = float(1).sub(p).pow(1.4);
  const pulseTint = mix(vec3(1.0, 0.95, 0.86), mix(vec3(0.72), vec3(0.5).add(vec3(0.5).mul(cos(vec3(0, 0.33, 0.67).add(d.mul(0.7)).mul(6.28318)))), 0.7), filmStrength);
  // 視界いっぱいに広がる面（カメラが殻の内側、中心が横・後ろ）では穏やかに。触れた点があるとき・外から見るときは全力
  const calm = mix(float(0.4), float(1), max(cameraOutside, uPulseOrigin.w));
  const rippleRaw = pulseTint.mul(ring.add(trail)).mul(fade).mul(1.3).mul(calm).mul(uFlash);
  // 出ていないときは必ず 0（途中の計算が NaN でも外へ出さない）
  const ripple = select(live, rippleRaw, vec3(0));

  // ── 組み立て ──
  const tint = materialColor.rgb;
  // 色ガラスの色は tint × A（普通の半透明と同じ見え方）。曇り・乳白は上下の光の違いで丸みを付ける。
  // 薄い殻（透明・虹色）の色は縁だけ。正面は face まで落とす（暗い背景では 3% の足し算でも視界全体の霞に見えるため）。
  // 色ガラス・曇り・乳白は面そのものに色がある物なので、正面でも色を残す
  const bodyFace = spec.thin ? float(face).add(smoothstep(0.05, 0.65, edge).mul(1 - face)) : float(1);
  const body = isMirror ? vec3(0) : tint.mul(alpha).mul(bodyFace).mul(spec.glow > 0 ? mix(float(0.7), float(1), normalWorld.y.mul(0.5).add(0.5)) : float(1));
  const user = materialEmissive; // params.emissive × emissiveIntensity（星や灯りの内側の光）

  material.opacityNode = alpha.clamp(0, 1);
  material.emissiveNode = body.add(reflection).add(film).add(glow).add(highlight).add(ripple).add(user);
  if (isMirror) {
    // 鏡は不透明で金属。環境画像がなくても真っ黒にならないよう、空と地面のグラデーションを薄く足す（環境画像があれば弱める）
    material.emissiveNode = reflection.mul(0.9).add(rimTint.mul(0.1).mul(fakeScale)).add(highlight).add(ripple).add(user);
    material.opacityNode = null;
  }

  return {
    material,
    setHighlight(level) {
      uHighlight.value = clamp01(level);
    },
    pulse(now, origin) {
      if (!Number.isFinite(now)) return;
      // 時刻も合わせる（setTime が次のフレームで来る前に描かれても、波紋が出遅れない）
      uTime.value = now;
      uPulseStart.value = now;
      const o = uPulseOrigin.value as THREE.Vector4;
      if (origin) o.set(origin.x, origin.y, origin.z, 1);
      else o.set(0, 0, 0, 0);
    },
    setTime(now) {
      if (Number.isFinite(now)) uTime.value = now;
    },
    dispose: () => material.dispose(),
  };
}

// ── 共有 ──

interface Shared {
  readonly handle: GlassHandle;
  refs: number;
}
const sharedPool = new Map<string, Shared>();

/** 引数の同じガラスを共有するための鍵（色は 16 進に揃える） */
function sharedKey(kind: GlassKind, params: GlassParams, tier: QualityTier): string {
  const c = (v: THREE.ColorRepresentation | undefined) => (v === undefined ? '' : new THREE.Color(v).getHexString());
  return [
    kind,
    tier,
    c(params.color),
    params.opacity ?? '',
    params.roughness ?? '',
    params.iridescence ?? '',
    c(params.emissive),
    params.emissiveIntensity ?? '',
    params.rim ?? '',
    params.face ?? '',
    params.doubleSided ? 'd' : 's',
  ].join('|');
}

/**
 * 種類・tier・引数が同じガラスを共有して返す。材質の組み立ては 1 つ数 ms かかるので、飾りのガラス
 * （温室の植物、雨粒、星の玉など、数十〜数百個）は 1 つずつ createGlass せずこちらを使う。
 *
 * 注意: 共有したハンドルの縁の光（setHighlight）・波紋（pulse）・時刻（setTime）は、共有している全員に効く。
 * 個別に光らせたい物（触れられる物）は createGlass で個別に作る。
 * dispose は呼んだ数だけ数えて、全員が手放したときに材質を解放する（二重の dispose は無視する）。
 */
export function sharedGlass(kind: GlassKind, params: GlassParams = {}, opts: GlassOptions = {}): GlassHandle {
  const tier = opts.tier ?? defaultTier;
  const key = sharedKey(kind, params, tier);
  let entry = sharedPool.get(key);
  if (!entry) {
    entry = { handle: createGlass(kind, params, { tier }), refs: 0 };
    sharedPool.set(key, entry);
  }
  entry.refs++;
  const e = entry;
  let released = false;
  return {
    material: e.handle.material,
    setHighlight: (level) => e.handle.setHighlight(level),
    pulse: (now, origin) => e.handle.pulse(now, origin),
    setTime: (now) => e.handle.setTime(now),
    dispose() {
      if (released) return;
      released = true;
      if (--e.refs <= 0) {
        e.handle.dispose();
        if (sharedPool.get(key) === e) sharedPool.delete(key);
      }
    },
  };
}

/**
 * 真鍮の細い枠（ゴンドラ、温室の鉄骨の飾り、街灯）。
 * 環境画像がない場面でも真っ黒にならないよう、反射方向の空と地面の色をごく薄く足す（環境画像があれば弱める）。
 */
export function createBrass(params: { readonly color?: THREE.ColorRepresentation; readonly roughness?: number } = {}): THREE.Material {
  const material = new THREE.MeshStandardNodeMaterial({
    color: params.color ?? 0xb08d57,
    roughness: params.roughness ?? 0.35,
    metalness: 1,
  });
  material.emissiveNode = materialColor.rgb.mul(mix(uGround, uSky, smoothstep(-0.4, 0.5, reflectVector.y))).mul(0.14).mul(fakeScale);
  return material;
}
