// 水面からゴンドラが浮かぶ音（gondola.rise）を、いつ鳴らすかを決める。設計書「乗り場」: 水面から透明な泡のゴンドラが浮かび上がり、目の前に止まる。
// 乗るたびに一度だけ、次のどちらかで鳴らす:
//   乗車前の案内の頭（画面で乗るとき）。案内は6秒あるので、乗車 0.5 秒の殻の閉じる音（gondola.close）とは重ならない
//   乗車の頭（案内がないとき: 2回目以降、「もう一度乗る」、VR）。殻の閉じる音は 0.5 秒後で、同じ調（A 短調のペンタトニック）の音どうし
// 乗車の頭を過ぎて始めたとき（?t= で途中から乗るとき）は鳴らさない: 浮かび上がりは乗車の頭より前の出来事。
import type { ViewMode } from '../contracts/ids';

export interface RiseSounder {
  /**
   * 乗車前の案内に入った（入るたびに一度呼ぶ）。画面で乗るときだけ、ここで鳴らす（VR の案内は画面に出ないので、乗車の頭で鳴らす）。
   */
  guideStarted(viewMode: ViewMode): void;
  /**
   * 乗車が始まった（startSec は乗車の始まりの秒。通常は 0、?t= の確認用は途中）。
   * 案内の頭で鳴らしていなければ、乗車の頭（startSec が 0 以下）で鳴らす。次の乗車のために数え直す。
   */
  rideStarted(startSec: number): void;
}

export function createRiseSounder(play: () => void): RiseSounder {
  /** この乗り場の準備（案内〜乗車）で、もう鳴らしたか */
  let sounded = false;
  return {
    guideStarted(viewMode) {
      if (viewMode !== 'screen') return;
      sounded = true;
      play();
    },
    rideStarted(startSec) {
      if (!sounded && startSec <= 0) play();
      sounded = false;
    },
  };
}
