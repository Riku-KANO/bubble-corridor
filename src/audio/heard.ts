// 「聞こえている位置」の時刻。映像の時計の元にする。
//
// AudioContext.currentTime は音の処理の塊（macOS で 3ms 前後の整数倍）ごとに進み、しかも「処理した」時刻であって
// 「耳に届いている」時刻ではない（出力の遅延ぶん先にいる。Bluetooth では 0.2 秒を超える）。そのまま映像の時計にすると、
// ゴンドラの動きが塊の大きさでガタつき、映像が音より先に進んでしまう。
// そこで getOutputTimestamp() の {contextTime, performanceTime}（いま耳に届いている音の時刻と、その実時間）から
// performance.now() で補間して、滑らかで出力遅延を引いた位置を作る。測定の揺れは、実時間の歩みを少しだけ（最大5%）
// 速めたり遅めたりして吸収する（位相同期のように）ので、時計は決して巻き戻らない。
//
// 音の予約も同じ位置を基準にする: 乗車の秒 t を鳴らす AudioContext の時刻は「聞こえている位置 + (t - 今の乗車の秒)」。
// これは t が耳に届く瞬間と、時計が t を指す瞬間を一致させる（予約の時刻は currentTime より出力遅延ぶん先になるので、
// 先読みはそれより長く取る）。

/** AudioContext のうち、ここで使う部分（テストで差し替える） */
export interface HeardContext {
  readonly state: string;
  readonly currentTime: number;
  readonly outputLatency?: number;
  readonly baseLatency?: number;
  getOutputTimestamp?(): { contextTime?: number; performanceTime?: number };
}

export interface HeardEnv {
  /** performance.now()（ミリ秒） */
  perfNow(): number;
  /** 今の AudioContext（まだなければ null） */
  context(): HeardContext | null;
}

export interface HeardTime {
  /** 時計の元。AudioContext が走っている間は聞こえている位置、止まっている間は実時間で進む。切り替わっても連続で、巻き戻らない */
  readonly source: { readonly currentTime: number };
  /** AudioContext の時間軸での聞こえている位置（滑らかで単調）。toContextTime の基準 */
  contextNow(): number;
  /** AudioContext の currentTime が、聞こえている位置よりどれだけ先にいるか（出力の遅延、秒、0 以上） */
  lag(): number;
}

/** 実時間の歩みを速める・遅める最大の割合（これを超える差は少しずつ詰める） */
const MAX_SLEW = 0.05;
/** これ以上ずれたら、滑らかに詰めずに合わせ直す（一時停止からの復帰など）。聞こえている位置が遠く遅れたときは、追いつくまで止める */
const SNAP = 0.3;
/** ほぼ同じ実時間（マイクロ秒単位の読み取りの重なり）に続けて読まれたら、同じ値を返す（ミリ秒）。長くすると、フレームごとの増分がその分ばらつく */
const SAME_READ_MS = 0.2;
/** getOutputTimestamp を呼び直す間隔（ミリ秒）。呼ぶたびにオブジェクトが作られるので間引く */
const TIMESTAMP_REFRESH_MS = 100;

export function createHeardTime(env: HeardEnv): HeardTime {
  let v = 0; // 聞こえている位置（AudioContext の時間軸）
  let have = false; // v が今の「走っている期間」で測れているか
  let src = env.perfNow() / 1000; // 時計の元の値。走っていない間は実時間で進み、走っている間は v + offset
  let offset = 0;
  let lastPerf = -1;
  let tsCtx = 0;
  let tsPerf = 0;
  let tsFetched = -Infinity;
  let tsValid = false;

  /** AudioContext の時間軸での、いま耳に届いている位置の測定値 */
  function measure(ctx: HeardContext, perf: number): number {
    let m: number | null = null;
    if (typeof ctx.getOutputTimestamp === 'function') {
      if (perf - tsFetched > TIMESTAMP_REFRESH_MS) {
        const ts = ctx.getOutputTimestamp();
        tsCtx = ts.contextTime ?? 0;
        tsPerf = ts.performanceTime ?? 0;
        tsFetched = perf;
        tsValid = tsPerf > 0 && Number.isFinite(tsCtx);
      }
      if (tsValid) m = tsCtx + (perf - tsPerf) / 1000;
    }
    if (m === null) {
      // 対応していない実装: currentTime から出力の遅延を引く（塊ごとの階段は、あとの滑らかにする処理で均す）
      m = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    }
    // 耳に届いている音が、処理済みの音（currentTime）より先にあることはない。遠く遅れることもない
    return Math.min(ctx.currentTime, Math.max(ctx.currentTime - 1, m));
  }

  function read(): void {
    const perf = env.perfNow();
    if (lastPerf >= 0 && perf - lastPerf < SAME_READ_MS) return;
    const dt = lastPerf < 0 ? 0 : (perf - lastPerf) / 1000;
    lastPerf = perf;
    const ctx = env.context();
    if (ctx === null || ctx.state !== 'running') {
      have = false;
      src += dt;
      return;
    }
    const m = measure(ctx, perf);
    if (!have) {
      v = m;
      have = true;
      offset = src - v; // 時計の元は、いまの値から続ける
    } else {
      const err = m - (v + dt);
      if (err > SNAP) v = m;
      // err < -SNAP: 聞こえている位置が遠く遅れた（音の処理が止まった）。巻き戻さず、追いつくまで時計も止める
      else if (err >= -SNAP) v += dt + Math.max(-MAX_SLEW * dt, Math.min(MAX_SLEW * dt, err));
    }
    src = v + offset;
  }

  return {
    source: {
      get currentTime() {
        read();
        return src;
      },
    },
    contextNow() {
      read();
      return v;
    },
    lag() {
      read();
      const ctx = env.context();
      return ctx !== null && have ? Math.max(0, ctx.currentTime - v) : 0;
    },
  };
}
