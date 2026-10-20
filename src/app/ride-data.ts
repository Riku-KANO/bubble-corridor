// rail.json の読み込み。Blender（今はコードの生成器）が書き出したものを使う。
// 外から来るデータは信頼しない: createRide に渡す前に validateRideData で形と値を確かめ、問題があれば警告を出して null（生成器で作る）。
import type { RideData } from '../contracts/ride';
import { validateRideData } from '../ride';

export async function loadRideData(): Promise<RideData | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}assets/rail.json`);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const problems = validateRideData(data);
    if (problems.length > 0) {
      console.warn('[ride] rail.json に問題があるので、生成器の道筋を使います:\n' + problems.map((p) => `  - ${p}`).join('\n'));
      return null;
    }
    return data as RideData;
  } catch {
    return null;
  }
}
