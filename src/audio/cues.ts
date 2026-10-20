// 音の側が先読みで鳴らす出来事の一覧と、見どころの前後で触れた音を控えめにする窓。
//
// 見どころ・膜の時刻は config（MOMENT_BARS、SECTIONS）の小節から決まる。ride 担当のキューシートと同じ計算なので、
// bus の cue を待たずに、先読みの中で乗車の秒から予約できる（cue を待つと、1フレームぶん遅れて小節の頭に合わない）。
import type { Cue, CueName } from '../contracts/events';
import type { SectionId } from '../contracts/ids';
import { CELESTIAL_BLACKOUT_SEC, DEWFALL_AFTER_BLOOM_BARS, MOMENT_BARS, SECTIONS, SEC_PER_BAR } from '../config';

function sectionAtBar(bar: number): SectionId {
  for (let i = SECTIONS.length - 1; i >= 0; i--) if (bar >= SECTIONS[i].startBar) return SECTIONS[i].id;
  return SECTIONS[0].id;
}

let cached: readonly Cue[] | null = null;

/** 音を鳴らす出来事（時刻の昇順）。膜は入った区間（data.to）に属する */
export function audioCues(): readonly Cue[] {
  if (cached) return cached;
  const list: Cue[] = [];
  const add = (name: CueName, bar: number, data?: Cue['data'], section: SectionId = sectionAtBar(bar)) => {
    list.push({ id: `${name}@${bar}`, name, t: bar * SEC_PER_BAR, bar, section, data });
  };
  add('hint.touch', MOMENT_BARS.hintTouch);
  for (const s of SECTIONS.slice(1)) add('membrane', s.startBar, { to: s.id }, s.id);
  add('greenhouse.bloom', MOMENT_BARS.greenhouseBloom);
  add('greenhouse.dewfall', MOMENT_BARS.greenhouseBloom + DEWFALL_AFTER_BLOOM_BARS);
  add('rain.freeze', MOMENT_BARS.rainFreeze);
  add('rain.doors', MOMENT_BARS.rainDoors);
  add('kaleidoscope.flower', MOMENT_BARS.kaleidoscopeFlower);
  const celestial = SECTIONS.find((s) => s.id === 'celestial')!;
  add('celestial.blackout', celestial.startBar);
  add('celestial.stars', celestial.startBar + CELESTIAL_BLACKOUT_SEC / SEC_PER_BAR);
  add('celestial.constellation', MOMENT_BARS.celestialConstellation);
  add('dawn.sunrise', MOMENT_BARS.dawnSunrise);
  cached = list.sort((a, b) => a.t - b.t);
  return cached;
}

/** この名前の出来事は音の側が先読みで鳴らす（bus の cue は重複の確認だけにする） */
export function isAudioCue(name: CueName): boolean {
  return audioCues().some((c) => c.name === name);
}

interface QuietMoment {
  /** 窓の始まりと終わり（乗車の秒） */
  readonly from: number;
  readonly to: number;
  /** 窓の中の触れた音の大きさの倍率 */
  readonly gain: number;
}

/** 見どころの何秒前から、何秒後まで触れた音を控えめにするか */
const QUIET_BEFORE = 1;
const QUIET_AFTER = 5;
/** 窓の縁をなだらかにする長さ（秒） */
const QUIET_RAMP = 0.5;
/** 見どころの数秒間に同時に鳴らす触れた音の上限（ふだんは config の maxTouchVoices） */
export const QUIET_MAX_VOICES = 4;

const quietMoment = (bar: number, gain: number): QuietMoment => ({ from: bar * SEC_PER_BAR - QUIET_BEFORE, to: bar * SEC_PER_BAR + QUIET_AFTER, gain });

/**
 * 見どころ（花、雨が止まる、模様、星座、朝日）の前後。「見どころの数秒間は、触れても演出を止めず、反応は控えめにして重ねる」。
 * 雨が止まる所は静けさそのものが見どころなので、特に小さくする。扉（分岐）は触れること自体が目的なので含めない。
 */
const QUIET: readonly QuietMoment[] = [
  quietMoment(MOMENT_BARS.greenhouseBloom, 0.55),
  quietMoment(MOMENT_BARS.rainFreeze, 0.35),
  quietMoment(MOMENT_BARS.kaleidoscopeFlower, 0.55),
  quietMoment(MOMENT_BARS.celestialConstellation, 0.55),
  quietMoment(MOMENT_BARS.dawnSunrise, 0.55),
];

/** 乗車の秒 t に鳴らす触れた音の大きさの倍率（1 = そのまま）。見どころの窓の中では下げ、縁でなだらかに戻す */
export function touchDuckAt(t: number): number {
  let f = 1;
  for (let i = 0; i < QUIET.length; i++) {
    const m = QUIET[i];
    if (t < m.from - QUIET_RAMP || t > m.to + QUIET_RAMP) continue;
    const edge = Math.min(1, (t - (m.from - QUIET_RAMP)) / QUIET_RAMP, (m.to + QUIET_RAMP - t) / QUIET_RAMP);
    const g = 1 - (1 - m.gain) * edge;
    if (g < f) f = g;
  }
  return f;
}

/** t が見どころの窓の中か（同時に鳴らす数を絞る判断に使う） */
export function inQuietMoment(t: number): boolean {
  for (let i = 0; i < QUIET.length; i++) if (t >= QUIET[i].from && t <= QUIET[i].to) return true;
  return false;
}
