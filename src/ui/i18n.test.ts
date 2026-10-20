// S-13 UI-3 言語（親が作成。実装担当は変更しない）
import { describe, expect, it } from 'vitest';
import { detectLang, MESSAGES, t, type MessageKey } from './i18n';

/** 設計書の画面に出る文言（キーは契約。足すのは自由、消さない） */
const REQUIRED: MessageKey[] = [
  'title',
  'subtitle',
  'queue.enter',
  'home.ride',
  'home.rideVR',
  'home.howto',
  'home.comfort',
  'home.settings',
  'home.shelf',
  'home.credits',
  'ticket.number',
  'guide.touch',
  'guide.look',
  'guide.comfort',
  'guide.skip',
  'ride.hint',
  'ride.pause',
  'pause.continue',
  'pause.comfort',
  'pause.volume',
  'pause.alight',
  'photo.save',
  'photo.share',
  'photo.rideAgain',
  'photo.toHome',
  'photo.wide',
  'photo.square',
  'record.touches',
  'record.door',
  'record.constellations',
  'record.hidden',
  'door.amber',
  'door.lapis',
  'settings.quality',
  'settings.look',
  'settings.comfort',
  'settings.sound',
  'settings.display',
  'shelf.empty',
  'shelf.delete',
  'back',
];

describe('UI-3 言語', () => {
  it('日本語と英語は同じキーを持ち、空の文言がない', () => {
    const ja = Object.keys(MESSAGES.ja).sort();
    const en = Object.keys(MESSAGES.en).sort();
    expect(en).toEqual(ja);
    for (const lang of ['ja', 'en'] as const) for (const [k, v] of Object.entries(MESSAGES[lang])) expect(v.trim(), `${lang}.${k}`).not.toBe('');
  });

  it('画面に必要な文言がそろっている', () => {
    for (const k of REQUIRED) {
      expect(MESSAGES.ja[k], `ja.${k}`).toBeTruthy();
      expect(MESSAGES.en[k], `en.${k}`).toBeTruthy();
    }
  });

  it('設計書の文言（日本語）', () => {
    expect(t('title', 'ja')).toBe('泡沫回廊');
    expect(t('title', 'en')).toBe('Utakata');
    expect(t('subtitle', 'en')).toBe('A Ride Through Glass');
    expect(t('ride.hint', 'ja')).toBe('触れると、鳴ります');
    expect(t('guide.touch', 'ja')).toBe('触れると鳴ります');
    expect(t('guide.look', 'ja')).toBe('見回せます');
    expect(t('guide.comfort', 'ja')).toBe('酔いやすい方は穏やかモードへ');
  });

  it('差し込み: 切符の便の数', () => {
    expect(t('ticket.number', 'ja', { n: 3 })).toContain('第3便');
    expect(t('ticket.number', 'en', { n: 3 })).toContain('No.3');
  });

  it('知らない差し込みは残さない・文言は HTML として解釈しない前提（文字列のまま）', () => {
    expect(t('ticket.number', 'ja', {})).not.toContain('{');
    expect(t('ticket.number', 'ja', { n: '<b>1</b>' })).toContain('<b>1</b>');
  });

  it('ブラウザの言語: 対応している最初の言語。なければ英語', () => {
    expect(detectLang(['ja-JP', 'en-US'])).toBe('ja');
    expect(detectLang(['en-GB'])).toBe('en');
    expect(detectLang(['fr-FR', 'ja'])).toBe('ja');
    expect(detectLang(['de-DE'])).toBe('en');
    expect(detectLang([])).toBe('en');
  });
});
