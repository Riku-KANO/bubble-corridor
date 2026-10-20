// 動きの上限の検査（RIDE-2、RIDE-4）。rail.json を読み、標準と穏やかの違反を一覧で出す。違反があれば終了コード 1。
//   pnpm comfort
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RideData } from '../src/contracts/ride.ts';
import { MOTION } from '../src/config.ts';
import { analyzeComfort, comfortPeaks } from '../src/ride/index.ts';

const data = JSON.parse(readFileSync(fileURLToPath(new URL('../public/assets/rail.json', import.meta.url)), 'utf8')) as RideData;
let total = 0;
for (const mode of ['standard', 'gentle'] as const) {
  const v = analyzeComfort(data, mode);
  total += v.length;
  const p = comfortPeaks(data, mode);
  const k = mode === 'gentle' ? MOTION.gentleFactor : 1;
  console.log(
    `${mode}: 違反 ${v.length} 件（最大 速度 ${p.speed.toFixed(2)}/${MOTION.speedMax}、加速度 ${p.accel.toFixed(2)}/${MOTION.accelMax}、上下 ${p.vertical.toFixed(2)}/${MOTION.verticalMax * k}、回転 ${p.yawRate.toFixed(1)}/${MOTION.yawRateMaxDeg * k}）`,
  );
  for (const x of v.slice(0, 20)) console.log(`  ${x.kind} ${x.t0.toFixed(1)}〜${x.t1.toFixed(1)}s 最大 ${x.peak.toFixed(3)}（上限 ${x.limit}）`);
}
process.exit(total === 0 ? 0 : 1);
