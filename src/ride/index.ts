// 乗り物と時間（レール、時刻 → 位置の対応、動きの上限の検査、キューシート、部屋の先読み）。
// 署名は契約どおり。中身は役割ごとのファイルに分けてここから公開する。
//   design.ts  レールと時刻表の設計（Blender のプレビズの代わり、ADR-0002）
//   rail.ts    時刻 → 位置と向き（poseAt）、区間
//   comfort.ts 動きの上限の検査
//   cues.ts    キューシートと出来事の配信
//   stream.ts  部屋の先読み
//   validate.ts 外から来る rail.json の検査
export { createWallClock } from './clock';
export { describeDesign, generateRideData } from './design';
export type { DesignInfo, HighlightName, Landmark, LegInfo } from './design';
export { createRide } from './rail';
export { analyzeComfort, comfortPeaks } from './comfort';
export type { ComfortPeaks } from './comfort';
export { buildCueSheet, createCueDispatcher } from './cues';
export type { CueDispatcher } from './cues';
export { streamingPlan } from './stream';
export type { StreamingPlan } from './stream';
export { validateRideData } from './validate';
