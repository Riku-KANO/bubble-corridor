// rail.json の読み込み。Blender（今はコードの生成器）が書き出したものを使う。読めなければ null（生成器で作る）。
import type { RideData } from '../contracts/ride';

export async function loadRideData(): Promise<RideData | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}assets/rail.json`);
    if (!res.ok) return null;
    const data = (await res.json()) as RideData;
    // 外から来るデータなので形だけは確かめる
    if (data?.version !== 1 || !Array.isArray(data.rail?.points) || !Array.isArray(data.timeline)) return null;
    return data;
  } catch {
    return null;
  }
}
