// rail.json と cues.json を書き出す（Blender の書き出しの代わり。ADR-0002）。
//   node scripts/build-ride-data.ts
// STUB: ride 担当が本実装（部屋ごとの形を持つレール、速度の設計）に置き換える。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCueSheet, generateRideData } from '../src/ride/index.ts';

const out = (name: string) => fileURLToPath(new URL(`../public/assets/${name}`, import.meta.url));
const data = generateRideData();
writeFileSync(out('rail.json'), `${JSON.stringify(data)}\n`);
writeFileSync(out('cues.json'), `${JSON.stringify(buildCueSheet(), null, 1)}\n`);
console.log(`rail.json: 点 ${data.rail.points.length}、時刻表 ${data.timeline.length}`);
