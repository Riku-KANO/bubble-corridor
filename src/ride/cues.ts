// キューシート（時刻 → 出来事）と、出来事の配信。
// 時刻は config の小節から計算する（見どころはすべて小節の頭。誘導だけは見どころの3秒前で小節の頭に乗らない）。
import { CELESTIAL_BLACKOUT_SEC, DEWFALL_AFTER_BLOOM_BARS, LURE_LEAD_SEC, MOMENT_BARS, RIDE_BARS, SEC_PER_BAR, SECTIONS, SHOTS } from '../config';
import type { Cue, CueName, EventBus } from '../contracts/events';
import type { SectionId } from '../contracts/ids';

/** 小節の数を表の id に使える形に（浮動小数点の端を落とす） */
const trimBar = (bar: number) => Math.round(bar * 1e6) / 1e6;

/** 小節 bar が属する区間 */
function sectionOfBar(bar: number): SectionId {
  for (let i = SECTIONS.length - 1; i > 0; i--) if (bar >= SECTIONS[i].startBar - 1e-9) return SECTIONS[i].id;
  return SECTIONS[0].id;
}

/** 誘導の対象になる見どころ（扉は現れること自体が合図なので誘導しない） */
const LURE_TARGETS: readonly { name: CueName; bar: number }[] = [
  { name: 'greenhouse.bloom', bar: MOMENT_BARS.greenhouseBloom },
  { name: 'rain.freeze', bar: MOMENT_BARS.rainFreeze },
  { name: 'kaleidoscope.flower', bar: MOMENT_BARS.kaleidoscopeFlower },
  { name: 'celestial.constellation', bar: MOMENT_BARS.celestialConstellation },
  { name: 'dawn.sunrise', bar: MOMENT_BARS.dawnSunrise },
];

const startBarOf = (id: SectionId) => SECTIONS.find((x) => x.id === id)!.startBar;
const CELESTIAL_START_BAR = startBarOf('celestial');
const DEPARTURE_START_BAR = startBarOf('departure');

/** 分岐の扉を確定する小節。扉が現れた後（5:50）で、万華鏡の膜（6:00）の手前 */
const BRANCH_DECIDE_BAR = MOMENT_BARS.rainDoors + 2;

/** キューシートを作る（時刻は config の小節から計算する）。時刻の昇順で、同じ時刻は作った順 */
export function buildCueSheet(): Cue[] {
  const cues: Cue[] = [];
  const add = (name: CueName, bar: number, data?: Cue['data']) => {
    const b = trimBar(bar);
    cues.push({ id: `${name}@${b}`, name, t: b * SEC_PER_BAR, bar: b, section: sectionOfBar(b), ...(data ? { data } : {}) });
  };

  // 同じ時刻の出来事は作った順に並ぶ。膜が先、見どころ、撮影の順になるよう、種類ごとにまとめて作る
  add('ride.start', 0);
  add('hint.touch', MOMENT_BARS.hintTouch);
  // 部屋の境目の膜（乗り場を除く各区間の頭）
  for (const sec of SECTIONS.slice(1)) add('membrane', sec.startBar, { to: sec.id });
  // 見どころの3秒前の誘導（小節の頭には乗らない）
  for (const target of LURE_TARGETS) add('lure', target.bar - LURE_LEAD_SEC / SEC_PER_BAR, { target: target.name });
  add('greenhouse.bloom', MOMENT_BARS.greenhouseBloom);
  add('greenhouse.dewfall', MOMENT_BARS.greenhouseBloom + DEWFALL_AFTER_BLOOM_BARS);
  add('rain.freeze', MOMENT_BARS.rainFreeze);
  add('rain.doors', MOMENT_BARS.rainDoors);
  add('branch.decide', BRANCH_DECIDE_BAR);
  add('kaleidoscope.flower', MOMENT_BARS.kaleidoscopeFlower);
  add('celestial.blackout', CELESTIAL_START_BAR);
  add('celestial.stars', CELESTIAL_START_BAR + CELESTIAL_BLACKOUT_SEC / SEC_PER_BAR);
  add('celestial.constellation', MOMENT_BARS.celestialConstellation);
  add('dawn.sunrise', MOMENT_BARS.dawnSunrise);
  add('departure.open', DEPARTURE_START_BAR);
  for (const shot of SHOTS) add('photo.capture', shot.bar, { shot: shot.shot });
  add('ride.end', RIDE_BARS);

  // 作った順を保ったまま時刻の昇順にそろえる（Array.sort は安定）
  return cues.sort((a, b) => a.t - b.t);
}

export interface CueDispatcher {
  /** 前回から t までに来た出来事を時刻順に一度だけ流す */
  update(t: number): void;
  /** 位置を変えた（確認用の早送り・巻き戻し）。t より前の出来事は流さない */
  reset(t: number): void;
}

/**
 * 出来事の配信。次に流す出来事の位置（next）を進める一方向の仕組みなので、
 * 一度だけ・時刻順になり、フレームが飛んでも取りこぼさない。reset 以外で時刻が戻っても流し直さない。
 */
export function createCueDispatcher(cues: readonly Cue[], bus: EventBus): CueDispatcher {
  let next = 0;
  return {
    update(t) {
      // 流している最中に受け手が reset しても続きが狂わないよう、位置を先に進めてから流す
      while (next < cues.length && cues[next].t <= t) bus.emit('cue', cues[next++]);
    },
    reset(t) {
      next = cues.findIndex((c) => c.t >= t);
      if (next < 0) next = cues.length;
    },
  };
}
