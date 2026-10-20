// 拍への合わせ。案1と共有する（音の仕組み。案2では必須）。
// STUB: 署名は確定。中身は audio 担当が本実装に置き換える。

/**
 * now（秒）以降で最も近い拍の格子点（秒）を返す（ちょうど格子点なら now そのもの）。
 * 格子は origin を 0 として、1拍 = 60/bpm 秒を subdivisionBeats ごとに刻む。
 * 格子点までが minLead 秒未満なら、その次の格子点にする（予約が間に合わないのを避ける）。
 */
export function nextGridTime(now: number, _origin: number, _bpm: number, _subdivisionBeats: number, _minLead = 0): number {
  return now; // STUB
}

/** 小節 → 秒（origin = 0） */
export function barToSec(bar: number, bpm: number, beatsPerBar: number): number {
  return (bar * beatsPerBar * 60) / bpm;
}

/** 秒 → 小節（小数） */
export function secToBar(sec: number, bpm: number, beatsPerBar: number): number {
  return (sec * bpm) / (60 * beatsPerBar);
}
