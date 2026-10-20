// 拍への合わせ。案1と共有する（音の仕組み。案2では必須）。

/**
 * now（秒）以降で最も近い拍の格子点（秒）を返す（ちょうど格子点なら now そのもの）。
 * 格子は origin を 0 として、1拍 = 60/bpm 秒を subdivisionBeats ごとに刻む。
 * 格子点までが minLead 秒未満なら、その次の格子点にする（予約が間に合わないのを避ける）。
 */
export function nextGridTime(now: number, origin: number, bpm: number, subdivisionBeats: number, minLead = 0): number {
  const step = (60 / bpm) * subdivisionBeats;
  // 浮動小数点の誤差（格子点ちょうどの入力が 1 ulp 手前になる）で 1 格子ぶん遅らせないよう、格子の 1e-9 倍だけ許す
  const k = Math.ceil((now + minLead - origin) / step - 1e-9);
  return origin + k * step;
}

/** 小節 → 秒（origin = 0） */
export function barToSec(bar: number, bpm: number, beatsPerBar: number): number {
  return (bar * beatsPerBar * 60) / bpm;
}

/** 秒 → 小節（小数） */
export function secToBar(sec: number, bpm: number, beatsPerBar: number): number {
  return (sec * bpm) / (60 * beatsPerBar);
}
