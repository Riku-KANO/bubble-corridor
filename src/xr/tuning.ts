// VR の細かい数値。設計書に値がなく、config（統合担当が持つ）にまだ無いものをここに置く。
// config に移す場合は XR / INTERACTION に同名で足し、ここから消す（報告に希望を書く）。
export const XR_TUNING = {
  /** 立って乗るとき、頭の高さが分からない場合の目の高さ（m） */
  standingEyeHeight: 1.6,
  /**
   * メニューの板の中心を目の高さからどれだけ下げるか（m）。見上げずに読める。
   * 開いた直後の見つめは、視線が一度外れるまで数えない処理で防ぐ（板の位置では防がない）
   */
  menuDrop: 0.12,
  /**
   * 板の下端が目の高さより下がってよい角度の上限（度、メニューの距離で）。項目が多い（背の高い）板は、
   * この角度に収まるよう中心を上げる。ゴンドラの手すり（目の約 0.5m 下）と重ならない約 20° を保つ
   */
  menuMaxDownDeg: 22,
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
  /** 見つめる・指す光線の前段の絞り込みの許容（度）。物の半径に、距離に比例して足す */
  gazeSlackDeg: 2,
  /** 毎フレーム、前段の絞り込みを通った物のうち、手前から何個の表面を確かめるか */
  rayCandidates: 3,
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
  /**
   * 注視点レンダリング（foveation、0〜1）。three r186 の setSession は、レイヤーを作る前にこの値を当てるので
   * 層に効かない。setSession の後に当て直す。既定は最大の 1。M0 の実機（Quest 3）で 0 / 0.5 / 1 を比べて決める。
   */
  foveation: 1,
  /** 頭の位置が推定（emulatedPosition）のままのとき、測り直しを待つフレーム数。3DoF だけの機器はその後に推定で測る */
  calibrateWaitFrames: 90,
  /** 白い霧の板の大きさ（m、距離 vignetteDistance の板で、片目の視野 ±70° を覆う） */
  whiteoutSize: 6,
} as const;
