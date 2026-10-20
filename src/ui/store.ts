// 設定と乗車をまたぐ記録の保存（localStorage）。
// 読んだ値は外から来るものとして扱い、項目ごとに検証する。不正な項目だけ既定値に戻し、正しい項目は残す。
// 保存できない環境（プライベートウィンドウ、容量超過）でも例外を出さない（storage.ts が受け止める）。
import { CAMERA, HIDDEN_BUBBLE_SECTIONS, INTERACTION, STORAGE_PREFIX } from '../config';
import type { Lang } from '../contracts/ids';
import type { Progress, Settings } from '../contracts/ui';
import { bool, num, oneOf, own, readJson, subsetOf, writeJson } from '../core/storage';
import { detectLang } from './i18n';

const SETTINGS_KEY = `${STORAGE_PREFIX}:settings`;
const PROGRESS_KEY = `${STORAGE_PREFIX}:progress`;

const TEXT_SCALES = [1, 1.25, 1.5] as const;

export function defaultSettings(lang: Lang = 'ja'): Settings {
  return {
    lang,
    quality: 'auto',
    lookMode: 'drag',
    gyro: false,
    fov: CAMERA.fovDeg,
    autoRecenter: true,
    comfort: 'standard',
    vignette: 0.35,
    volumes: { master: 0.8, music: 0.8, sfx: 0.8, ambient: 0.7 },
    reducedFlash: false,
    textScale: 1,
    gazeDwellSec: INTERACTION.gazeDwellSec,
    xrPosture: 'seated',
  };
}

/** ブラウザの言語（navigator.languages）。取れない環境では英語 */
function browserLang(): Lang {
  try {
    const list = navigator.languages?.length ? navigator.languages : [navigator.language];
    return detectLang(list.filter((x): x is string => typeof x === 'string'));
  } catch {
    return 'en';
  }
}

export function loadSettings(): Settings {
  const d = defaultSettings(browserLang());
  const raw = readJson(SETTINGS_KEY);
  if (raw === null) return d;
  const volumes = own(raw, 'volumes');
  return {
    lang: oneOf(own(raw, 'lang'), ['ja', 'en'] as const, d.lang),
    quality: oneOf(own(raw, 'quality'), ['auto', 'low', 'medium', 'high'] as const, d.quality),
    lookMode: oneOf(own(raw, 'lookMode'), ['drag', 'follow'] as const, d.lookMode),
    gyro: bool(own(raw, 'gyro'), d.gyro),
    fov: num(own(raw, 'fov'), d.fov, CAMERA.fovMinDeg, CAMERA.fovMaxDeg),
    autoRecenter: bool(own(raw, 'autoRecenter'), d.autoRecenter),
    comfort: oneOf(own(raw, 'comfort'), ['standard', 'gentle'] as const, d.comfort),
    vignette: num(own(raw, 'vignette'), d.vignette, 0, 1),
    volumes: {
      master: num(own(volumes, 'master'), d.volumes.master, 0, 1),
      music: num(own(volumes, 'music'), d.volumes.music, 0, 1),
      sfx: num(own(volumes, 'sfx'), d.volumes.sfx, 0, 1),
      ambient: num(own(volumes, 'ambient'), d.volumes.ambient, 0, 1),
    },
    reducedFlash: bool(own(raw, 'reducedFlash'), d.reducedFlash),
    textScale: oneOf(own(raw, 'textScale'), TEXT_SCALES, d.textScale),
    gazeDwellSec: oneOf(own(raw, 'gazeDwellSec'), INTERACTION.gazeDwellChoices, d.gazeDwellSec),
    xrPosture: oneOf(own(raw, 'xrPosture'), ['seated', 'standing'] as const, d.xrPosture),
  };
}

export function saveSettings(s: Settings): void {
  writeJson(SETTINGS_KEY, s);
}

const defaultProgress = (): Progress => ({ rideCount: 0, seenGuide: false, hiddenFound: [], lastDoor: null });

export function loadProgress(): Progress {
  const d = defaultProgress();
  const raw = readJson(PROGRESS_KEY);
  if (raw === null) return d;
  const door = own(raw, 'lastDoor');
  return {
    // 便の数は0以上の整数（小数は切り捨てる）
    rideCount: Math.floor(num(own(raw, 'rideCount'), d.rideCount, 0, Number.MAX_SAFE_INTEGER)),
    seenGuide: bool(own(raw, 'seenGuide'), d.seenGuide),
    // 隠れた泡があるのは5つの部屋だけ。重複と知らない名前は捨てる
    hiddenFound: subsetOf(own(raw, 'hiddenFound'), HIDDEN_BUBBLE_SECTIONS),
    lastDoor: door === 'amber' || door === 'lapis' ? door : null,
  };
}

export function saveProgress(p: Progress): void {
  writeJson(PROGRESS_KEY, p);
}
