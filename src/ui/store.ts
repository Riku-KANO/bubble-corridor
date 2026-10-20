// 設定と乗車をまたぐ記録の保存（localStorage）。
// STUB: 署名は確定。中身は ui 担当が本実装に置き換える（読んだ値の検証、既定値の補い）。
import type { Lang } from '../contracts/ids';
import type { Progress, Settings } from '../contracts/ui';

export function defaultSettings(lang: Lang = 'ja'): Settings {
  return {
    lang,
    quality: 'auto',
    lookMode: 'drag',
    gyro: false,
    fov: 75,
    autoRecenter: true,
    comfort: 'standard',
    vignette: 0.35,
    volumes: { master: 0.8, music: 0.8, sfx: 0.8, ambient: 0.7 },
    reducedFlash: false,
    textScale: 1,
    gazeDwellSec: 1.2,
    xrPosture: 'seated',
  };
}

export function loadSettings(): Settings {
  return defaultSettings(); // STUB
}

export function saveSettings(_s: Settings): void {
  // STUB
}

export function loadProgress(): Progress {
  return { rideCount: 0, seenGuide: false, hiddenFound: [], lastDoor: null }; // STUB
}

export function saveProgress(_p: Progress): void {
  // STUB
}
