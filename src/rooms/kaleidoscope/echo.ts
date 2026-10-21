// 触れた色のこだま（万華鏡の間）。触れたガラス片の色が、拍に合わせて近いロゼットから順に広がって残る。
// 光の明滅は 1 秒に 3 回未満の決まり（AGENTS.md）。画面効果の折り返しで画面中に広がるので、さらに控えめにする:
//   ・届く時刻は拍の頭に丸める（同じ拍に届いたこだまは 1 回の光にまとめる）→ 1 つのロゼットの光は 1 拍に 1 回まで
//     （72BPM で 1 秒に 1.2 回まで）
//   ・光の点滅を抑えるモードでは 2 拍の格子（1 秒に 0.6 回まで）にし、光も弱める
// どれも触れた記録と時刻だけで決まる（フレームの刻み方に依らない）。

export interface Echo {
  /** 触れた時刻（乗車の秒） */
  readonly t: number;
  /** 触れたガラス片のレール上の位置（m） */
  readonly s: number;
  readonly color: number;
}

/** こだまが 1 拍ずつ進む距離（m）。近いロゼットほど早く届く */
export const ECHO_STEP_M = 12;

/** 光の格子（秒）: 標準は 1 拍、光の点滅を抑えるモードは 2 拍 */
export function echoGrid(beat: number, reducedFlash: boolean): number {
  return reducedFlash ? beat * 2 : beat;
}

/** 触れた時刻 touchT のこだまが、距離 distance のロゼットへ届く時刻（格子の頭） */
export function echoArrival(touchT: number, distance: number, grid: number): number {
  const n = 1 + Math.floor(Math.max(0, distance) / ECHO_STEP_M);
  return Math.ceil(touchT / grid - 1e-9) * grid + n * grid;
}

export interface EchoState {
  /** 最後に届いた時刻（なければ -Infinity） */
  arrival: number;
  /** 届いた色（なければ -1）。同じ格子に複数届いたら、最後に触れたこだまの色 */
  color: number;
}

/** 時刻 t にロゼット（位置 rosetteS）に届いている最後のこだま。out に書いて返す（毎フレーム確保しない） */
export function echoAt(echoes: readonly Echo[], rosetteS: number, t: number, grid: number, out: EchoState): EchoState {
  out.arrival = -Infinity;
  out.color = -1;
  let lastTouch = -Infinity;
  for (const e of echoes) {
    const at = echoArrival(e.t, Math.abs(rosetteS - e.s), grid);
    if (at > t) continue;
    if (at > out.arrival + 1e-6 || (Math.abs(at - out.arrival) <= 1e-6 && e.t >= lastTouch)) {
      out.arrival = at;
      out.color = e.color;
      lastTouch = e.t;
    }
  }
  return out;
}

/** 届いた光の強さ（0〜1）。届いた瞬間に灯り、拍の半分ほどで消える */
export function echoFlash(t: number, arrival: number): number {
  if (!(arrival > -Infinity) || t < arrival) return 0;
  return Math.exp(-(t - arrival) / 0.35);
}
