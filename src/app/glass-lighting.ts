// 部屋ごとのガラスの擬似照明を、部屋の空気（Atmosphere）から作る（純粋）。
// ガラス（src/core/materials/glass.ts）は動く光源を持たず、setGlassLighting の共有の値で縁の反射とハイライトを作る。
// 既定は夜明けの空と地面なので、部屋が変わったら（空気の参照が変わったら）この値に差し替える。膜を通る瞬間（膜の効果が隠す）。
// 部屋が atmosphere.glassLighting で指定した項目はそれを優先し、指定のない項目だけ空気の背景色から作る。
//
// 暗い部屋（入口・乗り場・万華鏡・天球）では、ゴンドラの真鍮の縁はほぼ消える。真鍮の発光は「真鍮の色 × 地面の色 × 0.14」
// （createBrass）で、暗い部屋の地面の色は暗いため。ここで地面を暖かい色に寄せても、縁が見える明るさには届かない。
// 縁は VR の動かない基準なので、真鍮に部屋の照明とは別の発光の下限を持たせる直しが要る（core の材質。別のスライス）。
import * as THREE from 'three/webgpu';
import type { GlassLighting } from '../core/materials/glass';
import type { Atmosphere } from '../contracts/room';

// ── 空気から作るときのつまみ（設計書に値がないので仮。統合のときに config へ移す） ──

/** 空の明るさ（HSL の l）: 暗い部屋でも縁に空の色が見える下限と、背景の明るさに足す割合。上限は白飛びさせない */
const SKY_L_BASE = 0.55;
const SKY_L_FROM_BG = 0.35;
const SKY_L_MAX = 0.92;
/** 空は背景の色味を保ちつつ少し淡くする */
const SKY_SATURATION = 0.85;
/**
 * 地面: 背景の色と琥珀を、線形の RGB で混ぜる（色相を回さない。灰青の背景から緑がかった灰を作らない。混ぜる途中は灰を通る）。
 * 暗い部屋ほど琥珀へ寄せる（下から来る暖かい灯りに見せる）。混ぜた後で、明るさを空の線形の輝度に対する割合へ合わせる
 */
const GROUND_AMBER = '#ffb066';
const GROUND_AMBER_MIX_DARK = 0.7;
const GROUND_AMBER_MIX_BRIGHT = 0.4;
/** 地面の線形の輝度 ÷ 空の線形の輝度。1 未満なので、地面は必ず空より暗い */
const GROUND_TO_SKY_LUMINANCE = 0.6;
/** 部屋の明るさの見積もり（0: 夜、1: 昼）: 背景の明るさ（HSL の l）がこの範囲で変わる。ハイライトの強さと色、地面の暖かさに使う */
const DARK_L = 0.08;
const BRIGHT_L = 0.7;
/** ハイライトの強さ: 暗い部屋（夜）では弱く、明るい部屋では強く */
const KEY_MIN = 0.3;
const KEY_MAX = 1.1;
/**
 * ハイライトの色: 背景の色相は使わない（緑の温室の朝日が緑にならない）。暖色の白で、明るい部屋ほど朝日の金色に寄せる
 * （暗い部屋は灯り・星明かりの淡い暖色）。部屋が知っていれば glassLighting.keyColor で上書きする
 */
const KEY_COLOR_DARK = '#fff7ea';
const KEY_COLOR_BRIGHT = '#ffe6bd';
/** 光の来る向き。glass.ts の既定（夜明けの低い光）と同じ。部屋が知っていれば glassLighting.keyDir で上書きする */
const KEY_DIR = Object.freeze({ x: -0.35, y: 0.5, z: 0.79 });
/** scene.environment（環境画像）があるとき、擬似反射に掛ける倍率。環境画像の反射が主になるよう弱める。なければ 1 */
const ENV_REFLECTION_WITH_ENV = 0.4;

const amber = new THREE.Color(GROUND_AMBER);
const keyDark = new THREE.Color(KEY_COLOR_DARK);
const keyBright = new THREE.Color(KEY_COLOR_BRIGHT);
const hsl = { h: 0, s: 0, l: 0 };

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const smoothstep01 = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** 線形の輝度（Rec.709。THREE.Color の r・g・b は線形） */
const luminance = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** 空気から作った値。部屋の指定はこの上に重ねる */
function derive(atmosphere: Atmosphere): GlassLighting {
  const bg = new THREE.Color(atmosphere.background);
  bg.getHSL(hsl, THREE.SRGBColorSpace);
  const { h, s, l } = hsl;
  const bright = smoothstep01((l - DARK_L) / (BRIGHT_L - DARK_L));

  const sky = new THREE.Color().setHSL(h, s * SKY_SATURATION, Math.min(SKY_L_MAX, SKY_L_BASE + l * SKY_L_FROM_BG), THREE.SRGBColorSpace);

  const ground = bg.clone().lerp(amber, GROUND_AMBER_MIX_DARK + (GROUND_AMBER_MIX_BRIGHT - GROUND_AMBER_MIX_DARK) * bright);
  const mixed = luminance(ground);
  if (mixed > 1e-6) {
    // 色味を保って明るさだけ合わせる。どれかの色が 1 を超えるなら、そこで止める（輝度は目標より下がるだけで、空より暗いまま）
    const scale = Math.min((luminance(sky) * GROUND_TO_SKY_LUMINANCE) / mixed, 1 / Math.max(ground.r, ground.g, ground.b));
    ground.multiplyScalar(scale);
  }

  return {
    sky,
    ground,
    keyDir: KEY_DIR,
    keyColor: keyDark.clone().lerp(keyBright, bright),
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
