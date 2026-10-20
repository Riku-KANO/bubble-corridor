// ガラスの材質ライブラリ。案1と共有する。three/webgpu の NodeMaterial（TSL）で作り、
// WebGPU・WebGL2・VR の3つの描画経路で同じ見た目にする。
// 透過（transmission）は重く、重なると破綻するので、基本は縁の反射（フレネル）と薄膜干渉の虹色で見せる
// （設計書「描画の工夫」）。
// STUB: 署名は確定。中身は M0（core-visual 担当）で本実装に置き換える。
import * as THREE from 'three/webgpu';
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
  /** 触れたときの光の波紋。now は秒（波紋は約0.8秒で消える） */
  pulse(now: number): void;
  /** 毎フレームの時刻（秒）。虹色の流れと波紋に使う */
  setTime(now: number): void;
  dispose(): void;
}

export interface GlassOptions {
  readonly tier?: QualityTier;
}

export function createGlass(kind: GlassKind, params: GlassParams = {}, _opts: GlassOptions = {}): GlassHandle {
  // STUB: 標準の材質で近い見た目を出す
  const material = new THREE.MeshStandardNodeMaterial({
    color: params.color ?? (kind === 'milky' ? 0xf2f0ea : 0xd8ecff),
    roughness: params.roughness ?? (kind === 'frosted' ? 0.6 : 0.08),
    metalness: kind === 'mirror' ? 1 : 0,
    transparent: kind !== 'mirror',
    opacity: params.opacity ?? (kind === 'milky' ? 0.85 : 0.35),
    emissive: params.emissive ?? 0x000000,
    emissiveIntensity: params.emissiveIntensity ?? 0,
    side: params.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    depthWrite: false,
  });
  return {
    material,
    setHighlight() {},
    pulse() {},
    setTime() {},
    dispose: () => material.dispose(),
  };
}

/** 真鍮の細い枠（ゴンドラ、温室の鉄骨の飾り、街灯） */
export function createBrass(params: { readonly color?: THREE.ColorRepresentation; readonly roughness?: number } = {}): THREE.Material {
  return new THREE.MeshStandardNodeMaterial({
    color: params.color ?? 0xb08d57,
    roughness: params.roughness ?? 0.35,
    metalness: 1,
  });
}
