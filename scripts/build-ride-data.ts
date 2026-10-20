// rail.json と cues.json を書き出す（Blender の書き出しの代わり。ADR-0002）。
//   pnpm ride:data
// レールの形と速度の設計は src/ride/design.ts。ここは書き出しと、脚ごとの長さ・普段の速さの一覧を出す。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MOTION } from '../src/config.ts';
import { buildCueSheet, comfortPeaks, describeDesign, generateRideData } from '../src/ride/index.ts';

const out = (name: string) => fileURLToPath(new URL(`../public/assets/${name}`, import.meta.url));
const data = generateRideData();
const cues = buildCueSheet();
writeFileSync(out('rail.json'), `${JSON.stringify(data)}\n`);
writeFileSync(out('cues.json'), `${JSON.stringify(cues, null, 1)}\n`);

const info = describeDesign();
console.log('脚            時刻(s)       距離(m)         長さ  平均m/s  普段m/s');
for (const l of info.legs) {
  const len = l.s1 - l.s0;
  const avg = len / (l.t1 - l.t0);
  console.log(
    `${l.name.padEnd(14)}${`${l.t0.toFixed(0)}-${l.t1.toFixed(0)}`.padEnd(10)}${`${l.s0.toFixed(1)}-${l.s1.toFixed(1)}`.padEnd(16)}${len.toFixed(1).padStart(6)}${avg.toFixed(2).padStart(9)}${(l.cruise?.toFixed(2) ?? '-').padStart(9)}`,
  );
}
console.log(`輪を閉じる直線: 温室の頭 ${info.freeLines.a.toFixed(1)} m、夜明けの岸 ${info.freeLines.b.toFixed(1)} m。終点と始点の距離 ${info.closureGap.toFixed(2)} m`);
for (const mode of ['standard', 'gentle'] as const) {
  const p = comfortPeaks(data, mode);
  const k = mode === 'gentle' ? MOTION.gentleFactor : 1;
  console.log(
    `${mode}: 最大 速度 ${p.speed.toFixed(2)}/${MOTION.speedMax} m/s、加速度 ${p.accel.toFixed(2)}/${MOTION.accelMax} m/s²、上下 ${p.vertical.toFixed(2)}/${MOTION.verticalMax * k} m/s、回転 ${p.yawRate.toFixed(1)}/${MOTION.yawRateMaxDeg * k} °/s`,
  );
}
console.log(`rail.json: 点 ${data.rail.points.length}、時刻表 ${data.timeline.length}、cues.json: ${cues.length} 件`);
