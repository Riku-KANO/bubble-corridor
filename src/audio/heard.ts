// 「聞こえている位置」の時刻。映像の時計の元にする。
//
// AudioContext.currentTime は音の処理の塊（macOS で 3ms 前後の整数倍）ごとに進み、しかも「処理した」時刻であって
// 「耳に届いている」時刻ではない（出力の遅延ぶん先にいる。Bluetooth では 0.2 秒を超える）。そのまま映像の時計にすると、
// ゴンドラの動きが塊の大きさでガタつき、映像が音より先に進んでしまう。
// そこで getOutputTimestamp() の {contextTime, performanceTime}（いま耳に届いている音の時刻と、その実時間）から
// performance.now() で補間して、滑らかで出力遅延を引いた位置を作る。測定の揺れは、時計の歩みを実時間の 0.5〜1.25 倍の
// 範囲で、しかも倍率の変化に速さの上限をつけて追いかけるので、時計は止まらず・飛ばず・巻き戻らない。
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

/** 時計の歩み（実時間に対する倍率）の範囲。音の処理が遅れても進みすぎても、この範囲の速さで追いかける（止めない・飛ばさない） */
const RATE_MIN = 0.5;
const RATE_MAX = 1.25;
/** ずれを歩みの倍率に直す比例の係数（1/秒）。0.5 なら 0.1 秒のずれに 5% の歩みの差をつける */
const CHASE_GAIN = 0.5;
/**
 * 歩みの倍率が1秒に変えてよい量。ゴンドラの位置は時刻から決まるので、歩みの変化はそのまま加速度になる
 * （速さ 2 m/s なら 0.1/秒の変化は 0.2 m/s²。config の MOTION.accelMax = 0.5 m/s² に収める）
 */
const RATE_SLEW = 0.1;
/** これを超えて進んでいる・遅れているときだけ、合わせ直す（追いつき方は上と同じだが、遅れすぎは進めて飛ばす）。巻き戻しはしない */
const RESYNC = 2;
/** 音の処理の速さ（実時間に対する倍率）を推定するときの、ならす時間（秒） */
const RATE_ESTIMATE_TAU = 2;
/** ほぼ同じ実時間（マイクロ秒単位の読み取りの重なり）に続けて読まれたら、同じ値を返す（ミリ秒）。長くすると、フレームごとの増分がその分ばらつく */
const SAME_READ_MS = 0.2;
/** getOutputTimestamp を呼び直す間隔（ミリ秒）。呼ぶたびにオブジェクトが作られるので間引く */
const TIMESTAMP_REFRESH_MS = 100;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export function createHeardTime(env: HeardEnv): HeardTime {
  let v = 0; // 聞こえている位置（AudioContext の時間軸）
  let have = false; // v が今の「走っている期間」で測れているか
  let src = env.perfNow() / 1000; // 時計の元の値。走っていない間は実時間で進み、走っている間は v + offset
  let offset = 0;
  let lastPerf = -1;
  let rate = 1; // いまの時計の歩み（実時間に対する倍率）
  let audioRate = 1; // 音の処理が進む速さの推定（実時間に対する倍率）。過負荷だと 1 を下回る
  let tsCtx = 0;
  let tsPerf = 0;
  let tsFetched = -Infinity;
  let tsValid = false;
  // currentTime から測るとき（getOutputTimestamp がない実装）の、速さの推定用の前回の測定
  let slopePerf = -1;
  let slopeM = 0;

  /** 音の処理の速さの測定（実時間 dtMs ミリ秒で、音の時刻が dCtx 秒進んだ）を、推定にならして入れる */
  function observeRate(dCtx: number, dtMs: number): void {
    if (dtMs <= 0) return;
    const sample = clamp(dCtx / (dtMs / 1000), 0, 2);
    audioRate += (sample - audioRate) * (1 - Math.exp(-dtMs / 1000 / RATE_ESTIMATE_TAU));
  }

  /** AudioContext の時間軸での、いま耳に届いている位置の測定値 */
  function measure(ctx: HeardContext, perf: number): number {
    let m: number | null = null;
    if (typeof ctx.getOutputTimestamp === 'function') {
      if (perf - tsFetched > TIMESTAMP_REFRESH_MS) {
        const ts = ctx.getOutputTimestamp();
        const newCtx = ts.contextTime ?? 0;
        const newPerf = ts.performanceTime ?? 0;
        const valid = newPerf > 0 && Number.isFinite(newCtx);
        if (valid && tsValid) observeRate(newCtx - tsCtx, newPerf - tsPerf);
        tsCtx = newCtx;
        tsPerf = newPerf;
        tsFetched = perf;
        tsValid = valid;
      }
      if (tsValid) m = tsCtx + (perf - tsPerf) / 1000;
    }
    if (m === null) {
      // 対応していない実装: currentTime から出力の遅延を引く（塊ごとの階段は、追いかける処理で均す）
      m = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
      if (slopePerf >= 0 && perf - slopePerf >= TIMESTAMP_REFRESH_MS) {
        observeRate(m - slopeM, perf - slopePerf);
        slopePerf = perf;
        slopeM = m;
      } else if (slopePerf < 0) {
        slopePerf = perf;
        slopeM = m;
      }
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
      // 音が止まっている間は実時間で進む。再開したときは測り直す
      have = false;
      tsFetched = -Infinity;
      tsValid = false;
      slopePerf = -1;
      src += dt;
      return;
    }
    const m = measure(ctx, perf);
    if (!have) {
      v = m;
      have = true;
      rate = 1;
      audioRate = 1;
      src += dt; // 測り直す読み取りでも、時計は実時間ぶん進める（止めない）
      offset = src - v; // 時計の元は、いまの値から続ける
    } else {
      // 今の歩みのまま dt 進んだとして、音に対してどれだけずれるか（正: 時計が音より遅れる）。読み取りの間隔が長くても過剰に直さない
      const err = m - (v + rate * dt);
      if (err > RESYNC) {
        // 2秒を超えて遅れている（長い一時停止の後など）。進めて合わせ直す
        v = m;
        rate = 1;
      } else if (err >= -RESYNC) {
        // 音の処理の速さに、ずれを縮める分を足した速さで進む。止めず、飛ばさず、倍率は範囲の中で少しずつ変える
        const target = clamp(audioRate + CHASE_GAIN * err, RATE_MIN, RATE_MAX);
        const step = RATE_SLEW * dt;
        rate += clamp(target - rate, -step, step);
        v += rate * dt;
      }
      // err < -RESYNC: 音の処理が2秒以上遅れた（音が長く止まった）。巻き戻さず、2秒以内に戻るまで時計を止める
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
