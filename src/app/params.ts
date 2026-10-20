// 確認用の URL パラメータ。外から来る値なので、既知のキーだけを検証して読む。
//   ?debug            性能表示（fps、描画呼び出し、時刻、区間）
//   ?t=590            乗車の 590 秒の位置から始める（待ち列・入口・案内を飛ばす）
//   ?rate=4           時計を早送りする（音を使わない時計のときだけ）
//   ?webgl            WebGPU があっても WebGL2 で描く
//   ?lang=en          言語を上書きする
//   ?screen=home      最初の画面（queue / home / photo）
//   ?screen=home&t=588  入口で止まり、「乗る」「VRで乗る」で 588 秒から乗る（Quest 3 で天球から VR を確かめる）
//   ?door=amber       扉の選択を固定する
//   ?quality=low      品質を上書きする
//   ?nofx             後処理を切る
import type { DoorChoice, Lang } from '../contracts/ids';
import type { QualitySetting } from '../contracts/ui';
import { RIDE_DURATION } from '../config';
import { oneOf } from '../core/storage';

export interface DevParams {
  readonly debug: boolean;
  readonly t: number | null;
  readonly rate: number;
  readonly webgl: boolean;
  readonly lang: Lang | null;
  readonly screen: 'queue' | 'home' | 'photo' | null;
  readonly door: DoorChoice | null;
  readonly quality: QualitySetting | null;
  readonly nofx: boolean;
}

export function parseParams(search: string): DevParams {
  const q = new URLSearchParams(search);
  const numIn = (key: string, min: number, max: number): number | null => {
    const raw = q.get(key);
    if (raw === null || raw.trim() === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= min && v <= max ? v : null;
  };
  const pick = <T extends string>(key: string, choices: readonly T[]): T | null => {
    const raw = q.get(key);
    return raw === null ? null : (oneOf(raw, choices, '' as T) || null);
  };
  return {
    debug: q.has('debug'),
    t: numIn('t', 0, RIDE_DURATION),
    rate: numIn('rate', 0.1, 60) ?? 1,
    webgl: q.has('webgl'),
    lang: pick('lang', ['ja', 'en'] as const),
    screen: pick('screen', ['queue', 'home', 'photo'] as const),
    door: pick('door', ['amber', 'lapis'] as const),
    quality: pick('quality', ['auto', 'low', 'medium', 'high'] as const),
    nofx: q.has('nofx'),
  };
}
