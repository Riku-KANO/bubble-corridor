// ガラスの材質ライブラリ。案1と共有する。three/webgpu の NodeMaterial（TSL）で作り、
// WebGPU・WebGL2・VR の3つの描画経路で同じ見た目にする。
// 透過（transmission）は重く、重なると破綻するので使わない。縁の反射（フレネル）と薄膜干渉の虹色で
// 「ガラスらしさ」を出す（設計書「描画の工夫」）。
//
// 組み立て:
//   ・視線と法線の角度 nv から、縁の強さ（フレネル）と光が通る道のり（厚み）を出す。
//   ・不透明度 A は「材質の opacity を、道のりに応じて縁ほど厚くしたもの」（ベール＝ランベルト・ベールの吸収の近似）。
//   ・ブレンドは「背景 × (1 - A) ＋ 出力」（premultiplied）。出力（emissive）に入れた縁の反射・虹色・波紋は
//     A に薄められず、そのままの明るさで乗る。色ガラスの色は tint × A として足すので、普通の半透明と同じ見え方。
//   ・動く光源は持たない。反射は「空と地面のグラデーション」と、夜明けの低い光の2つのハイライトを
//     視線の反射方向だけで描く（環境画像があれば、その反射も標準の材質が重ねる）。
//   ・tier で計算を減らす: high=ノイズ2段の虹色の流れ・曇りのざらつき、medium=ノイズ1段、low=サイン波だけ。
//
// 触れたときの反応（縁の光・波紋・時刻）はすべて uniform なので、次のフレームから即座に効く（シェーダを作り直さない）。
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
  positionLocal,
  positionView,
  positionViewDirection,
  positionWorld,
  pow,
  reflectVector,
  saturate,
  sin,
  smoothstep,
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
}

/** ガラスの材質と、触れたときの反応を動かすつまみ */
export interface GlassHandle {
  readonly material: THREE.Material;
  /** 縁の光（0〜1）。触れられる物に近づいたとき */
  setHighlight(level: number): void;
  /**
   * 触れたときの光の波紋。now は秒（波紋は約0.8秒で消える）。
   * origin（世界座標の触れた点）を渡すと、その点から面に沿って広がる。省くと、見えている面の中心から縁へ広がる。
   */
  pulse(now: number, origin?: THREE.Vector3): void;
  /** 毎フレームの時刻（秒）。虹色の流れと波紋に使う */
  setTime(now: number): void;
  dispose(): void;
}

export interface GlassOptions {
  readonly tier?: QualityTier;
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
}

const SPECS: Record<GlassKind, Spec> = {
  clear: { color: 0xd8ecff, opacity: 0.1, roughness: 0.04, metalness: 0, rim: 0.9, power: 3.2, thickness: 0.9, film: 0.12, glow: 0, grain: 0, edgeFade: 0 },
  frosted: { color: 0xdfeaf6, opacity: 0.2, roughness: 0.6, metalness: 0, rim: 0.5, power: 1.6, thickness: 0.5, film: 0, glow: 0.3, grain: 1, edgeFade: 0 },
  tinted: { color: 0x86d1b4, opacity: 0.42, roughness: 0.06, metalness: 0, rim: 0.7, power: 3.2, thickness: 1, film: 0.05, glow: 0, grain: 0, edgeFade: 0 },
  iridescent: { color: 0xeaf4ff, opacity: 0.08, roughness: 0.03, metalness: 0, rim: 0.8, power: 2.6, thickness: 0.6, film: 1, glow: 0, grain: 0, edgeFade: 0 },
  milky: { color: 0xf5eee2, opacity: 0.62, roughness: 0.28, metalness: 0, rim: 0.4, power: 2.4, thickness: 0.1, film: 0.1, glow: 0.3, grain: 0, edgeFade: 1 },
  mirror: { color: 0xeef3ff, opacity: 1, roughness: 0.04, metalness: 1, rim: 0.2, power: 3, thickness: 0, film: 0, glow: 0, grain: 0, edgeFade: 0 },
};

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** 夜明けの低い光が来る向き（世界座標）。窓のような広いハイライトと、点のような鋭いハイライトを作る */
const KEY_DIR = new THREE.Vector3(-0.35, 0.5, 0.79).normalize();
/** 毎フレームの計算で使い回す（物ごとに new しない） */
const _center = new THREE.Vector3();

export function createGlass(kind: GlassKind, params: GlassParams = {}, opts: GlassOptions = {}): GlassHandle {
  const tier: QualityTier = opts.tier ?? 'medium';
  const spec = SPECS[kind];
  const isMirror = kind === 'mirror';
  const rimStrength = clamp01(params.rim ?? spec.rim);
  const filmStrength = clamp01(params.iridescence ?? spec.film);

  const material = new THREE.MeshStandardNodeMaterial({
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

  // ── 反射（視線の反射方向だけで描く） ──
  const refl = reflectVector;
  const sky = vec3(0.5, 0.72, 1.0);
  const ground = vec3(1.0, 0.78, 0.62);
  const rimTint = mix(ground, sky, smoothstep(-0.45, 0.55, refl.y));
  const keyDot = max(dot(refl, vec3(KEY_DIR.x, KEY_DIR.y, KEY_DIR.z)), 0);
  const roughSoft = 1 - Math.min(1, (params.roughness ?? spec.roughness) * 1.4); // 粗いほどハイライトは広く弱い
  const keyBroad = pow(keyDot, 9).mul(0.22 * (1.2 - roughSoft));
  const keySharp = pow(keyDot, 170).mul(1.7 * roughSoft * roughSoft);
  const reflection = rimTint.mul(fres).mul(rimStrength * 1.25).add(vec3(1.0, 0.96, 0.9).mul(keyBroad.add(keySharp)).mul(0.35 + rimStrength));

  // ── 薄膜干渉の虹色 ──
  let film: THREE.Node<'vec3'> = vec3(0);
  if (filmStrength > 0.001) {
    const thick = path.sub(1).clamp(0, 2.6);
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
    const phase = thick.mul(0.5).add(swirl.mul(0.34)).add(uTime.mul(0.02));
    const wave = vec3(0, 0.33, 0.67).add(phase);
    const rainbow = vec3(0.5).add(vec3(0.5).mul(cos(wave.mul(6.28318))));
    // 色がきつすぎないよう白へ寄せる。縁ほど強く、真正面でもうっすら見える
    const pastel = mix(vec3(0.72), rainbow, 0.78);
    film = pastel.mul(filmStrength).mul(float(0.28).add(edge.mul(0.9)));
    alpha = alpha.add(filmStrength * 0.06);
  }

  // ── 内側のぼんやりした光（曇り・乳白が光を散らす） ──
  // 上は空の冷たい色、下は地面の暖かい色を受けて、丸みが出る
  const hemi = mix(vec3(1.0, 0.82, 0.7), vec3(0.78, 0.9, 1.0), normalWorld.y.mul(0.5).add(0.5));
  const glow = spec.glow > 0 ? materialColor.rgb.mul(hemi).mul(spec.glow).mul(float(0.5).add(nv.mul(0.5))) : vec3(0);

  // ── 縁の光（触れられる物に近づいたとき） ──
  const highlight = vec3(0.92, 0.97, 1.0).mul(uHighlight).mul(fres.mul(1.1).add(0.035));

  // ── 触れたときの波紋 ──
  const elapsed = uTime.sub(uPulseStart);
  const live = step(0, elapsed).mul(step(elapsed, PULSE_SEC));
  const p = saturate(elapsed.div(PULSE_SEC));
  // 距離の測り方: 触れた点があれば世界座標でそこから、なければ見えている面の中心から（画面の上で測る）
  const centerView = cameraViewMatrix.mul(vec4(uBounds.xyz, 1)).xyz;
  const offset = positionView.xy.div(positionView.z.negate()).sub(centerView.xy.div(centerView.z.negate()));
  const dView = length(offset).div(uBounds.w.div(centerView.z.negate()).max(1e-4));
  const dWorld = length(positionWorld.sub(uPulseOrigin.xyz)).div(uBounds.w.mul(1.1).max(1e-4));
  const d = mix(dView, dWorld, uPulseOrigin.w);
  // 広がり方は最初が速く、だんだんゆっくり（水面の波紋）。縁を越えて抜けきる
  const front = float(1).sub(float(1).sub(p).pow(2)).mul(1.7);
  const ring = exp(d.sub(front).div(0.11).pow(2).negate());
  const trail = smoothstep(front, front.sub(0.55), d).mul(0.07);
  const fade = float(1).sub(p).pow(1.4);
  const pulseTint = mix(vec3(1.0, 0.95, 0.86), mix(vec3(0.72), vec3(0.5).add(vec3(0.5).mul(cos(vec3(0, 0.33, 0.67).add(d.mul(0.7)).mul(6.28318)))), 0.7), filmStrength);
  const ripple = pulseTint.mul(ring.add(trail)).mul(fade).mul(live).mul(1.3);

  // ── 組み立て ──
  const tint = materialColor.rgb;
  // 色ガラスの色（普通の半透明と同じ見え方）。曇り・乳白は上下の光の違いで丸みを付ける
  const body = isMirror ? vec3(0) : tint.mul(alpha).mul(spec.glow > 0 ? mix(float(0.7), float(1), normalWorld.y.mul(0.5).add(0.5)) : float(1));
  const user = materialEmissive; // params.emissive × emissiveIntensity（星や灯りの内側の光）

  material.opacityNode = alpha.clamp(0, 1);
  material.emissiveNode = body.add(reflection).add(film).add(glow).add(highlight).add(ripple).add(user);
  if (isMirror) {
    // 鏡は不透明で金属。環境画像がなくても真っ黒にならないよう、空と地面のグラデーションを薄く足す
    material.emissiveNode = reflection.mul(0.9).add(rimTint.mul(0.1)).add(highlight).add(ripple).add(user);
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

/**
 * 真鍮の細い枠（ゴンドラ、温室の鉄骨の飾り、街灯）。
 * 環境画像がない場面でも真っ黒にならないよう、反射方向の空と地面の色をごく薄く足す。
 */
export function createBrass(params: { readonly color?: THREE.ColorRepresentation; readonly roughness?: number } = {}): THREE.Material {
  const material = new THREE.MeshStandardNodeMaterial({
    color: params.color ?? 0xb08d57,
    roughness: params.roughness ?? 0.35,
    metalness: 1,
  });
  const sky = vec3(0.6, 0.75, 1.0);
  const ground = vec3(1.0, 0.78, 0.55);
  material.emissiveNode = materialColor.rgb.mul(mix(ground, sky, smoothstep(-0.4, 0.5, reflectVector.y))).mul(0.14);
  return material;
}
