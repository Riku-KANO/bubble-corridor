// @vitest-environment jsdom
// S-13 UI-4 設定と記録の保存（親が作成。実装担当は変更しない）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_PREFIX } from '../config';
import { defaultSettings, loadProgress, loadSettings, saveProgress, saveSettings } from './store';

const SETTINGS_KEY = `${STORAGE_PREFIX}:settings`;
const PROGRESS_KEY = `${STORAGE_PREFIX}:progress`;

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('UI-4 設定の保存', () => {
  it('保存がなければ既定値。言語はブラウザの言語で決める', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['ja-JP', 'en-US']);
    expect(loadSettings()).toEqual(defaultSettings('ja'));
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US']);
    expect(loadSettings().lang).toBe('en');
  });

  it('既定値は設計書どおり（視野角75°、標準モード、見つめる1.2秒、正面へ戻す on）', () => {
    const d = defaultSettings('ja');
    expect(d).toMatchObject({ fov: 75, comfort: 'standard', gazeDwellSec: 1.2, autoRecenter: true, textScale: 1, reducedFlash: false });
  });

  it('保存して読み直すと同じ', () => {
    const s = { ...defaultSettings('en'), fov: 82, comfort: 'gentle' as const, lookMode: 'follow' as const, textScale: 1.5 as const, gazeDwellSec: 2.0 as const };
    saveSettings(s);
    expect(loadSettings()).toEqual(s);
  });

  it('壊れた保存は既定値に戻す', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['ja-JP']);
    localStorage.setItem(SETTINGS_KEY, '{not json');
    expect(loadSettings()).toEqual(defaultSettings('ja'));
  });

  it('不正な値は項目ごとに既定値に戻し、正しい値は残す', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['ja-JP']);
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ lang: 'fr', fov: 200, lookMode: 'xxx', comfort: 'gentle', volumes: { master: 2, music: 0.3, sfx: 'a' }, textScale: 1.25, gazeDwellSec: 0.8, vignette: -1 }),
    );
    const s = loadSettings();
    const d = defaultSettings('ja');
    expect(s.lang).toBe('ja');
    expect(s.fov).toBe(d.fov);
    expect(s.lookMode).toBe(d.lookMode);
    expect(s.comfort).toBe('gentle');
    expect(s.volumes).toEqual({ ...d.volumes, music: 0.3 });
    expect(s.textScale).toBe(1.25);
    expect(s.gazeDwellSec).toBe(0.8);
    expect(s.vignette).toBe(d.vignette);
  });

  it('__proto__ などで汚染されない', () => {
    localStorage.setItem(SETTINGS_KEY, '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}}}');
    loadSettings();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
  });

  it('保存できない環境（容量超過・プライベートウィンドウ）でも例外を出さない', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => saveSettings(defaultSettings('ja'))).not.toThrow();
    expect(() => saveProgress({ rideCount: 1, seenGuide: true, hiddenFound: [], lastDoor: null })).not.toThrow();
  });
});

describe('UI-4 / INT-6 乗車をまたぐ記録', () => {
  it('既定値は 0 便・案内は未読・泡はなし・扉はなし', () => {
    expect(loadProgress()).toEqual({ rideCount: 0, seenGuide: false, hiddenFound: [], lastDoor: null });
  });

  it('保存して読み直すと同じ', () => {
    const p = { rideCount: 3, seenGuide: true, hiddenFound: ['rain', 'greenhouse'] as const, lastDoor: 'amber' as const };
    saveProgress({ ...p, hiddenFound: [...p.hiddenFound] });
    expect(loadProgress()).toEqual({ ...p, hiddenFound: ['rain', 'greenhouse'] });
  });

  it('隠れた泡は5つの部屋だけ（重複・知らない名前・乗り場は捨てる）、便の数は0以上の整数', () => {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ rideCount: -4, seenGuide: 'yes', hiddenFound: ['rain', 'rain', 'platform', 'mars', 'dawn'], lastDoor: 'red' }));
    expect(loadProgress()).toEqual({ rideCount: 0, seenGuide: false, hiddenFound: ['rain', 'dawn'], lastDoor: null });
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ rideCount: 2.7 }));
    expect(loadProgress().rideCount).toBe(2);
  });
});
