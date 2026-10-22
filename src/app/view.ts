// 画面の縦横比に合わせた縦の視野角（設計書「縦持ちでは視野角を広げ」）。
// 縦の視野角を固定したまま縦持ちにすると、左右の視野が狭くなる（75° のままでは水平の半角が 17° ほど）。
// 5:51 の扉や 2:40 の花が画面の端で切れるので、左右の半角が一定以上になるまで縦の視野角を広げる。
// 画面（PC・スマートフォン）の描画と見回しだけで使う。VR は頭の向きとヘッドセットの視野をそのまま使う。
// 撮影（ライドフォト）は 16:9 の決まった大きさなので使わない。

import { CAMERA } from '../config';

/** 縦持ちで保ちたい水平の半角（度）と、縦の視野角の上限（度。これ以上は魚眼のような歪みが目立ち、酔いやすい）。値は config の CAMERA */
const MIN_HORIZONTAL_HALF_DEG = CAMERA.portraitMinHorizontalHalfDeg;
const MAX_VERTICAL_FOV_DEG = CAMERA.portraitMaxVerticalFovDeg;

/**
 * 縦の視野角。横長（左右の半角が足りている縦横比）は設定のまま、縦持ちは左右の半角が MIN_HORIZONTAL_HALF_DEG になるまで広げる。
 * 縦横比に対して連続（max と min だけで組む。端末を回している途中で視野が跳ばない）。
 * @param aspect 幅 / 高さ
 * @param baseFovDeg 設定の縦の視野角（度）
 */
export function verticalFovFor(aspect: number, baseFovDeg: number): number {
  if (!(aspect > 0) || !Number.isFinite(aspect)) return baseFovDeg;
  // 水平の半角が MIN_HORIZONTAL_HALF_DEG になる縦の視野角: tan(v/2) = tan(h) / aspect
  const wanted = (2 * Math.atan(Math.tan((MIN_HORIZONTAL_HALF_DEG * Math.PI) / 180) / aspect) * 180) / Math.PI;
  // 設定が上限を超えているときは設定を尊重する（広げるだけで、狭めない）
  return Math.max(baseFovDeg, Math.min(wanted, MAX_VERTICAL_FOV_DEG));
}
