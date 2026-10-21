// S-24 REN-2「VR は低め」: 一体型のヘッドセットのブラウザでは、起動時から VR 向けの品質で部屋を読み込む。
// PC に VR 機器をつないだ環境（xr が使えるだけ）は巻き込まない（レビュー1巡目 P2-2 をテストにしたもの。親が作成。実装担当は変更しない）
import { describe, expect, it } from 'vitest';
import { deviceHints, isStandaloneHeadset } from './device';

const QUEST =
  'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.2.0.4.53 SamsungBrowser/4.0 Chrome/126.0.6478.122 VR Safari/537.36';
const PICO =
  'Mozilla/5.0 (Linux; Android 12; PICO 4 Build/SKQ1.221119.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.105 VR Safari/537.36 PicoBrowser/3.3.38';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

describe('REN-2 一体型のヘッドセットの判定', () => {
  it('Quest（Meta のブラウザ）と Pico のブラウザは一体型', () => {
    expect(isStandaloneHeadset(QUEST)).toBe(true);
    expect(isStandaloneHeadset(PICO)).toBe(true);
  });

  it('PC とスマートフォンは一体型ではない', () => {
    for (const ua of [MAC_CHROME, WIN_CHROME, IPHONE, ANDROID]) expect(isStandaloneHeadset(ua), ua).toBe(false);
  });
});

describe('REN-2 起動時の端末の手がかり', () => {
  const base = { coarsePointer: false, hardwareConcurrency: 8, screenPixels: 1920 * 1080 };

  it('一体型のヘッドセットでは isXR が真（VR 向けの低めの品質）', () => {
    expect(deviceHints({ ...base, userAgent: QUEST }).isXR).toBe(true);
    expect(deviceHints({ ...base, userAgent: PICO }).isXR).toBe(true);
  });

  it('PC では、VR が使える（xrCapable）だけでは isXR にしない', () => {
    expect(deviceHints({ ...base, userAgent: WIN_CHROME, xrCapable: true }).isXR).toBe(false);
    expect(deviceHints({ ...base, userAgent: MAC_CHROME }).isXR).toBe(false);
  });

  it('スマートフォンは指で触る画面（coarse）から isMobile、ほかの手がかりはそのまま渡す', () => {
    const h = deviceHints({ ...base, userAgent: IPHONE, coarsePointer: true, deviceMemoryGB: 4, gpu: 'Apple GPU' });
    expect(h.isMobile).toBe(true);
    expect(h.isXR).toBe(false);
    expect(h).toMatchObject({ hardwareConcurrency: 8, deviceMemoryGB: 4, gpu: 'Apple GPU', screenPixels: 1920 * 1080 });
  });
});
