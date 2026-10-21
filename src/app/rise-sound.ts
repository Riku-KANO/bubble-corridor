// 水面からゴンドラが浮かぶ音（gondola.rise）を、いつ鳴らすかを決める。設計書「乗り場」: 水面から透明な泡のゴンドラが浮かび上がり、目の前に止まる。
// 乗るたびに一度だけ、次のどちらかで鳴らす:
//   乗車前の案内の頭（画面で乗るとき）。案内に入って delaySec 後（改札の音が鳴り終わってから）。
//     案内は6秒あるので、乗車 0.5 秒の殻の閉じる音（gondola.close）とは重ならない。delaySec より前に飛ばしたら取り消す（下の乗車の頭へ）
//   乗車の頭（案内がないとき: 2回目以降、「もう一度乗る」、VR、案内を早く飛ばしたとき）。殻の閉じる音は 0.5 秒後で、同じ調（A 短調のペンタトニック）の音どうし
// 乗車の頭を過ぎて始めたとき（?t= で途中から乗るとき）は鳴らさない: 浮かび上がりは乗車の頭より前の出来事。
import type { ViewMode } from '../contracts/ids';

export interface RiseSounder {
  /**
   * 乗車前の案内に入った（入るたびに一度呼ぶ）。画面で乗るときだけ、delaySec 後に鳴らす（VR の案内は画面に出ないので、乗車の頭で鳴らす）。
   */
  guideStarted(viewMode: ViewMode): void;
  /**
   * 乗車が始まった（startSec は乗車の始まりの秒。通常は 0、?t= の確認用は途中）。
   * 案内で鳴らしていなければ（案内がない・飛ばした）、乗車の頭（startSec が 0 以下）で鳴らす。待っている音は取り消す。次の乗車のために数え直す。
   */
  rideStarted(startSec: number): void;
}

export function createRiseSounder(play: () => void, delaySec: number): RiseSounder {
  /** この乗り場の準備（案内〜乗車）で、もう鳴らしたか */
  let sounded = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    guideStarted(viewMode) {
      if (viewMode !== 'screen') return;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        sounded = true;
        play();
      }, delaySec * 1000);
    },
    rideStarted(startSec) {
      cancel();
      if (!sounded && startSec <= 0) play();
      sounded = false;
    },
  };
}
