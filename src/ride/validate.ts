// 外から来る rail.json の検査。fetch で読んだ JSON は信頼しないので、createRide に渡す前に形と値を確かめる（AGENTS.md「セキュリティ」）。
// 問題の一覧を日本語で返す（空なら問題なし）。値の範囲は「壊れていないか」まで。動きの上限は analyzeComfort が見る。
import { SECTION_IDS } from '../contracts/ids';
import { RIDE_DURATION } from '../config';

/** 点や時刻表の数の上限（壊れたデータや悪意のあるデータで重くならないように） */
const MAX_ENTRIES = 200_000;
/** 書き出しの丸めで s がわずかに減るのは許す（m） */
const S_TOLERANCE = 1e-4;
/** 隣の点の3Dの間隔の許容（spacing に対する割合。RIDE-8） */
const SPACING_TOLERANCE = 0.1;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** RideData として使えるか確かめる。問題の一覧を返す（空なら問題なし） */
export function validateRideData(data: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(data)) return ['rail.json がオブジェクトではない'];
  if (data.version !== 1) errors.push(`version が 1 ではない（${String(data.version)}）`);
  if (!finite(data.duration) || data.duration <= 0) errors.push('duration が正の数ではない');
  else if (Math.abs(data.duration - RIDE_DURATION) > 1e-3) errors.push(`duration が乗車時間（${RIDE_DURATION} 秒）と違う（${data.duration}）`);

  // レールの点
  let railLength = 0;
  const rail = data.rail;
  if (!isObject(rail)) errors.push('rail がオブジェクトではない');
  else {
    const spacing = rail.spacing;
    const points = rail.points;
    if (!finite(spacing) || spacing <= 0) errors.push('rail.spacing が正の数ではない');
    if (!Array.isArray(points)) errors.push('rail.points が配列ではない');
    else if (points.length < 2) errors.push('rail.points が2点未満');
    else if (points.length > MAX_ENTRIES) errors.push(`rail.points が多すぎる（${points.length} 点）`);
    else {
      const bad = points.findIndex((p) => !Array.isArray(p) || p.length !== 3 || !p.every(finite));
      if (bad >= 0) errors.push(`rail.points[${bad}] が [x, y, z] の有限の数ではない`);
      else if (finite(spacing)) {
        railLength = (points.length - 1) * spacing;
        // 点は3Dで spacing の等間隔（s は3Dの弧長。ADR-0008）。水平の距離で並べた書き出しなどを見つける
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1] as number[];
          const b = points[i] as number[];
          const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
          if (Math.abs(d - spacing) > spacing * SPACING_TOLERANCE) {
            errors.push(`rail.points[${i}] の3Dの間隔 ${d.toFixed(3)}m が spacing ${spacing}m ±${SPACING_TOLERANCE * 100}% の外`);
            break;
          }
        }
      }
    }
  }

  // 時刻表
  const timeline = data.timeline;
  if (!Array.isArray(timeline)) errors.push('timeline が配列ではない');
  else if (timeline.length < 2) errors.push('timeline が2点未満');
  else if (timeline.length > MAX_ENTRIES) errors.push(`timeline が多すぎる（${timeline.length} 点）`);
  else {
    let ok = true;
    for (let i = 0; i < timeline.length && ok; i++) {
      const e = timeline[i];
      if (!isObject(e) || !finite(e.t) || !finite(e.s)) {
        errors.push(`timeline[${i}] が { t, s } の有限の数ではない`);
        ok = false;
      } else if (i > 0) {
        const prev = timeline[i - 1] as { t: number; s: number };
        if (!(e.t > prev.t)) {
          errors.push(`timeline[${i}].t が増えていない`);
          ok = false;
        } else if (e.s < prev.s - S_TOLERANCE) {
          errors.push(`timeline[${i}].s が減っている`);
          ok = false;
        }
      }
    }
    if (ok) {
      const first = timeline[0] as { t: number; s: number };
      const last = timeline[timeline.length - 1] as { t: number; s: number };
      if (Math.abs(first.t) > 1e-6) errors.push('timeline が時刻 0 から始まっていない');
      if (finite(data.duration) && last.t < data.duration - 1e-6) errors.push('timeline が duration まで届いていない');
      if (railLength > 0 && last.s > railLength + 3 * (finite((rail as Record<string, unknown>).spacing) ? ((rail as Record<string, unknown>).spacing as number) : 1)) {
        errors.push('timeline の最後の距離がレールの長さを超えている');
      }
    }
  }

  // 穏やかモード用の高さ（あれば点と同じ数）
  if (data.gentleY !== undefined) {
    const points = isObject(rail) && Array.isArray(rail.points) ? rail.points.length : -1;
    if (!Array.isArray(data.gentleY) || data.gentleY.length !== points || !data.gentleY.every(finite)) errors.push('gentleY が rail.points と同じ数の有限の数の配列ではない');
  }

  // 区間
  // 区間: 7区間が順に、隙間なく並ぶ
  const sections = data.sections;
  if (!Array.isArray(sections) || sections.length === 0) errors.push('sections が空');
  else if (sections.length !== SECTION_IDS.length) errors.push(`sections が ${SECTION_IDS.length} 区間ではない（${sections.length}）`);
  else {
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      if (!isObject(s) || s.id !== SECTION_IDS[i] || !finite(s.s0) || !finite(s.s1) || s.s1 < s.s0) {
        errors.push(`sections[${i}] が { id: ${SECTION_IDS[i]}, s0, s1 } として正しくない`);
        break;
      }
      const prev = i > 0 ? (sections[i - 1] as { s1: number }) : null;
      if (prev && Math.abs((s.s0 as number) - prev.s1) > 1e-3) {
        errors.push(`sections[${i}] の s0 が前の区間の s1 と続いていない`);
        break;
      }
    }
  }
  return errors;
}
