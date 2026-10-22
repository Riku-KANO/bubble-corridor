// 部屋の空気を場面に反映する（背景・霧・露出・環境画像）。霧は物を作り直さず、色と距離だけを書き換える。
//
// なぜ霧を null にしないのか: three r186 は、霧の有無を「描く物の鍵」に含める。霧のある部屋とない部屋の境目で scene.fog を
// Fog と null の間で行き来すると、見えている材質すべての組み立てが作り直される（480 秒の万華鏡 → 天球、750 秒の岸 → 降車で
// WebGL2 約 2 秒の止まり。ADR-0014）。霧のない部屋では、霧の物は残したまま、近い側を描く範囲の外まで遠ざける（ノードの形を変えない）。
import type * as THREE from 'three/webgpu';
import type { Atmosphere } from '../contracts/room';

/** 霧のない部屋で、霧の始まりと終わりをこの距離にする。カメラの far（config の CAMERA）よりずっと遠く、霧の係数が 0 のままになる */
export const FOG_OFF_NEAR = 100_000;
export const FOG_OFF_FAR = 200_000;

/** 霧の物の色と距離を、部屋の空気に合わせる。霧のない空気は、色はそのまま、距離だけを遠くへ */
export function applyFog(fog: THREE.Fog, atmosphere: Atmosphere): void {
  if (atmosphere.fog) {
    fog.color.set(atmosphere.fog.color);
    fog.near = atmosphere.fog.near;
    fog.far = atmosphere.fog.far;
  } else {
    fog.near = FOG_OFF_NEAR;
    fog.far = FOG_OFF_FAR;
  }
}
