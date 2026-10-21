// 部屋ごとのガラスの擬似照明を、部屋の空気（Atmosphere）から作る（純粋）。
// ガラス（src/core/materials/glass.ts）は動く光源を持たず、setGlassLighting の共有の値で縁の反射とハイライトを作る。
// 既定は夜明けの空と地面なので、部屋が変わったら（空気の参照が変わったら）この値に差し替える。膜を通る瞬間（膜の効果が隠す）。
// 部屋が atmosphere.glassLighting で指定した項目はそれを優先し、指定のない項目だけ空気の背景色から作る。
import * as THREE from 'three/webgpu';
import type { GlassLighting } from '../core/materials/glass';
import type { Atmosphere } from '../contracts/room';

// ── 空気から作るときのつまみ（設計書に値がないので仮。config には足さず、この関数の中で閉じる） ──

/** 空の明るさ（HSL の l）: 暗い部屋でも縁に空の色が見える下限と、背景の明るさに足す割合。上限は白飛びさせない */
const SKY_L_BASE = 0.55;
const SKY_L_FROM_BG = 0.35;
const SKY_L_MAX = 0.92;
/**
 * 地面の明るさ: 背景より暗く、空より必ず暗くなる（SKY_L_BASE > GROUND_L_BASE、SKY_L_FROM_BG > GROUND_L_FROM_BG）。
 * 暗い部屋でも、ゴンドラの縁（真鍮の手すり。動かない基準）が地面の色を映して、うっすら見えるように下限を持つ
 */
const GROUND_L_BASE = 0.42;
const GROUND_L_FROM_BG = 0.3;
/**
 * 空は背景の色味を保ちつつ少し淡く、地面は背景から暖かい色（琥珀）へ寄せる。暗い部屋ほど暖かく寄せる:
 * ゴンドラの真鍮の縁は地面の色を映して見える（createBrass）ので、暗い藍の部屋でも暖かい色が縁をうっすら見せ、動かない基準が消えない
 */
const SKY_SATURATION = 0.85;
const GROUND_SATURATION = 0.8;
const WARM_HUE = 30 / 360;
const GROUND_WARM_SHIFT_BRIGHT = 0.25;
const GROUND_WARM_SHIFT_DARK = 1;
/** 部屋の明るさの見積もり（0: 夜、1: 昼）: 背景の明るさ（HSL の l）がこの範囲で変わる。ハイライトの強さと、地面の暖かさに使う */
const DARK_L = 0.08;
const BRIGHT_L = 0.7;
/** ハイライトの強さ: 暗い部屋（夜）では弱く、明るい部屋では強く */
const KEY_MIN = 0.3;
const KEY_MAX = 1.1;
/** ハイライトの色: 背景の色味の白（淡く、明るく） */
const KEY_SATURATION = 0.45;
const KEY_L = 0.92;
/** 光の来る向き。glass.ts の既定（夜明けの低い光）と同じ。部屋が知っていれば glassLighting.keyDir で上書きする */
const KEY_DIR = Object.freeze({ x: -0.35, y: 0.5, z: 0.79 });
/** scene.environment（環境画像）があるとき、擬似反射に掛ける倍率。環境画像の反射が主になるよう弱める。なければ 1 */
const ENV_REFLECTION_WITH_ENV = 0.4;

const hsl = { h: 0, s: 0, l: 0 };

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 0〜1 の色相の最短の弧で、from から to へ amount だけ寄せる */
function hueToward(from: number, to: number, amount: number): number {
  let d = to - from;
  if (d > 0.5) d -= 1;
  else if (d < -0.5) d += 1;
  const h = from + d * amount;
  return h - Math.floor(h);
}

const smoothstep01 = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** 空気から作った値。部屋の指定はこの上に重ねる */
function derive(atmosphere: Atmosphere): GlassLighting {
  const bg = new THREE.Color(atmosphere.background);
  bg.getHSL(hsl, THREE.SRGBColorSpace);
  const { h, s, l } = hsl;
  const bright = smoothstep01((l - DARK_L) / (BRIGHT_L - DARK_L));
  const sky = new THREE.Color().setHSL(h, s * SKY_SATURATION, Math.min(SKY_L_MAX, SKY_L_BASE + l * SKY_L_FROM_BG), THREE.SRGBColorSpace);
  const ground = new THREE.Color().setHSL(
    hueToward(h, WARM_HUE, GROUND_WARM_SHIFT_DARK + (GROUND_WARM_SHIFT_BRIGHT - GROUND_WARM_SHIFT_DARK) * bright),
    s * GROUND_SATURATION,
    GROUND_L_BASE + l * GROUND_L_FROM_BG,
    THREE.SRGBColorSpace,
  );
  const keyColor = new THREE.Color().setHSL(h, s * KEY_SATURATION, KEY_L, THREE.SRGBColorSpace);
  return {
    sky,
    ground,
    keyDir: KEY_DIR,
    keyColor,
    keyIntensity: KEY_MIN + (KEY_MAX - KEY_MIN) * bright,
    envReflection: atmosphere.environment ? ENV_REFLECTION_WITH_ENV : 1,
  };
}

/** 空気の参照ごとに一度だけ作る（部屋の空気が変わったときだけ作る。毎フレーム呼んでも確保しない） */
const cache = new WeakMap<Atmosphere, GlassLighting>();

/**
 * 部屋の空気から、ガラスの擬似照明を作る。同じ空気（同じ参照）には同じオブジェクトを返す。戻り値は凍結してあり、書き換えない。
 * atmosphere.glassLighting にある項目は、空気から作った値より優先する。
 */
export function glassLightingFor(atmosphere: Atmosphere): GlassLighting {
  let lighting = cache.get(atmosphere);
  if (lighting) return lighting;
  const base = derive(atmosphere);
  const own = atmosphere.glassLighting;
  lighting = Object.freeze({
    sky: own?.sky ?? base.sky,
    ground: own?.ground ?? base.ground,
    keyDir: own?.keyDir ?? base.keyDir,
    keyColor: own?.keyColor ?? base.keyColor,
    keyIntensity: own?.keyIntensity ?? base.keyIntensity,
    envReflection: own?.envReflection ?? base.envReflection,
  });
  cache.set(atmosphere, lighting);
  return lighting;
}
