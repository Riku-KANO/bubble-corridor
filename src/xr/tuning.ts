// VR の細かい数値。設計書に値がなく、config（統合担当が持つ）にまだ無いものをここに置く。
// config に移す場合は XR / INTERACTION に同名で足し、ここから消す（報告に希望を書く）。
export const XR_TUNING = {
  /** 立って乗るとき、頭の高さが分からない場合の目の高さ（m） */
  standingEyeHeight: 1.6,
  /** メニューを目の高さからどれだけ下げて出すか（m）。見上げずに読める */
  menuDrop: 0.12,
  /** メニューの横幅（m）。1.2m の先で視野の約44° */
  menuWidth: 0.96,
  /** 外周の暗さの輪: 暗さが始まる角度、完全に暗い角度、板の端の角度（度、距離 1m の板で作る） */
  vignetteInnerDeg: 32,
  vignetteDarkDeg: 60,
  vignetteOuterDeg: 75,
  /** 輪の板までの距離（m）。近いと左右の目で位置がずれて見えるので 1m 離す */
  vignetteDistance: 1,
  /** 外周の暗さが強まるときの追従（半減期、秒）。ちらつかせない */
  vignetteHalfLife: 0.25,
  /** 強さに応じて輪の内側を狭める割合（0〜1） */
  vignetteShrink: 0.25,
  /** 見つめる光線の許容（度）。頭の微かな揺れで外れない */
  gazeSlackDeg: 2,
  /** 触れられる物の縁が最大に光る指先の距離（表面から、m） */
  fingerNearReach: 0.25,
  /** 近づいたときの縁の光の上限（かすかに） */
  proximityGlowMax: 0.6,
  /** 指先の光の玉の半径（m） */
  tipRadius: 0.008,
  /** 振動の強さ（0〜1）と長さ（ms） */
  hapticStrength: 0.35,
  hapticMs: 30,
  /** メニューを指で押す深さ（板の手前から奥へ、m） */
  menuPokeBehind: 0.05,
} as const;
