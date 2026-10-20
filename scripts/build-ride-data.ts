// rail.json と cues.json を書き出す（Blender の書き出しの代わり。ADR-0002）。
//   pnpm ride:data
// レールの形と速度の設計は src/ride/design.ts。ここは書き出しと、脚ごとの長さ・速さ・高さと、部屋の担当が使う目印の一覧を出す。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MOTION } from '../src/config.ts';
import { buildCueSheet, comfortPeaks, describeDesign, generateRideData, validateRideData } from '../src/ride/index.ts';

const out = (name: string) => fileURLToPath(new URL(`../public/assets/${name}`, import.meta.url));
const data = generateRideData();
const problems = validateRideData(data);
if (problems.length > 0) throw new Error(`rail.json の検査に通らない: ${problems.join(' / ')}`);
const cues = buildCueSheet();
writeFileSync(out('rail.json'), `${JSON.stringify(data)}\n`);
writeFileSync(out('cues.json'), `${JSON.stringify(cues, null, 1)}\n`);

const info = describeDesign();
const f = (v: number, w: number, d = 1) => v.toFixed(d).padStart(w);
console.log('脚             時刻(s)    距離s(m)         長さ  平均  最大  普段   高さy(m)');
for (const l of info.legs) {
  const len = l.s1 - l.s0;
  console.log(
    `${l.name.padEnd(14)}${`${l.t0.toFixed(0)}-${l.t1.toFixed(0)}`.padEnd(10)}${`${l.s0.toFixed(1)}-${l.s1.toFixed(1)}`.padEnd(16)}${f(len, 6)}${f(len / (l.t1 - l.t0), 6, 2)}${f(l.maxSpeed, 6, 2)}${(l.cruise?.toFixed(2) ?? '-').padStart(6)}   ${l.yMin.toFixed(1)}〜${l.yMax.toFixed(1)}`,
  );
}
console.log(`輪を閉じる直線: 温室の頭 ${info.freeLines.a.toFixed(1)} m、夜明けの岸 ${info.freeLines.b.toFixed(1)} m。終点と始点の距離 ${info.closureGap.toFixed(2)} m`);

const lm = (name: string, p: { t: number; s: number; x: number; y: number; z: number; yaw: number }) =>
  console.log(`  ${name.padEnd(24)} t ${f(p.t, 6)}  s ${f(p.s, 6)}  (${f(p.x, 7)}, ${f(p.y, 5)}, ${f(p.z, 7)})  yaw ${f((p.yaw * 180) / Math.PI, 6, 0)}°`);
console.log('目印（部屋の担当が物を置く基準。x は東、-z が北）');
lm('乗り場の始点', info.dock);
for (const m of info.membranes) lm(`膜 → ${m.to}`, m);
for (const [name, p] of Object.entries(info.highlights)) lm(name, p);
console.log(
  `  ホール: 中心 (${info.hall.x.toFixed(1)}, ${info.hall.z.toFixed(1)}) 半径 ${info.hall.radius.toFixed(1)} m。天球: 中心 (${info.celestial.center.x.toFixed(1)}, ${info.celestial.center.y.toFixed(1)}, ${info.celestial.center.z.toFixed(1)})、入口の膜まで ${info.celestial.entryRadius.toFixed(1)} m、出口の膜まで ${info.celestial.exitRadius.toFixed(1)} m`,
);
console.log(`  床と水面: ${JSON.stringify(info.floors)}`);

for (const mode of ['standard', 'gentle'] as const) {
  const p = comfortPeaks(data, mode);
  const k = mode === 'gentle' ? MOTION.gentleFactor : 1;
  console.log(
    `${mode}: 最大 速度 ${p.speed.toFixed(2)}/${MOTION.speedMax} m/s、加速度 ${p.accel.toFixed(2)}/${MOTION.accelMax} m/s²、上下 ${p.vertical.toFixed(2)}/${MOTION.verticalMax * k} m/s、回転 ${p.yawRate.toFixed(1)}/${MOTION.yawRateMaxDeg * k} °/s`,
  );
}
console.log(`rail.json: 点 ${data.rail.points.length}、時刻表 ${data.timeline.length}、cues.json: ${cues.length} 件`);
