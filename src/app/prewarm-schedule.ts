// 先読みを始めてよい時刻（純粋）。膜の前後は、膜の効果・部屋の入れ替え・次の部屋の読み込みが重なるので、先読みの重い一歩
// （大きなテクスチャの転送は 1 回で 60ms ほど主スレッドを占める）を重ねない。先読みは部屋が読み込まれた後の静かな間に進める。

/** 膜のこの秒数前から、先読みの新しい一歩を始めない */
export const QUIET_BEFORE_MEMBRANE_SEC = 2;
/** 膜のこの秒数後まで、先読みの新しい一歩を始めない（膜の後に次の部屋の読み込みが終わり、先読みが始まりやすい） */
export const QUIET_AFTER_MEMBRANE_SEC = 5;

/**
 * 乗車の時刻 t が膜（区間の境目）の前後の静かにしておく間か。boundaries は区間の始まりの時刻（昇順でなくてよい）。
 * 乗車の頭（0）も境目として扱う（殻が閉じる間に温室の先読みを重ねない）
 */
export function inMembraneQuiet(t: number, boundaries: readonly number[]): boolean {
  for (const b of boundaries) if (t >= b - QUIET_BEFORE_MEMBRANE_SEC && t <= b + QUIET_AFTER_MEMBRANE_SEC) return true;
  return false;
}
