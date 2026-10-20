// 進行の時計。楽曲の再生時刻をすべての基準にする（設計書「進行の時計」）。
// 本番は音の担当の AudioContext から作る時計、テストと確認ページは手で進める時計を使う。

export interface RideClock {
  /** 乗車の頭からの秒。ポーズ中は止まる。0 未満にも RIDE_DURATION 超にもならない */
  readonly time: number;
  readonly running: boolean;
  /** t 秒の位置から動かし始める */
  start(t?: number): void;
  pause(): void;
  /** ポーズした位置から続ける */
  resume(): void;
  /** 位置だけを変える（確認用。running は変えない） */
  seek(t: number): void;
}
