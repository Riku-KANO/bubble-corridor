// @vitest-environment jsdom
// S-13 画面（親が作成。実装担当は変更しない）
// UI は状態を読んで表示し、UiCommands を呼ぶだけ。見た目（曇りガラス、指で書く文字）は dev/ui.html と snap で確かめる。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RideRecord } from '../contracts/events';
import type { PhotoRecord } from '../contracts/photo';
import type { ScreenId, UiCommands, UiState } from '../contracts/ui';
import { UI } from '../config';
import { t } from './i18n';
import { defaultSettings, mountUi, type UiHandle } from './index';

let root: HTMLElement;
let ui: UiHandle;
let cmd: { [K in keyof UiCommands]: ReturnType<typeof vi.fn> };

const record: RideRecord = { rideNo: 3, date: '2026-10-20', touches: 42, door: 'amber', constellations: 2, hiddenFound: ['rain'] };
const photo: PhotoRecord = {
  id: 'ride-3-1',
  createdAt: 1,
  meta: { rideNo: 3, date: '2026-10-20', door: 'amber', hiddenTotal: 2, constellations: 2, lang: 'ja' },
  shots: [
    { shot: 'bloom', image: new Blob(['a'], { type: 'image/png' }) },
    { shot: 'freeze', image: new Blob(['b'], { type: 'image/png' }) },
    { shot: 'constellation', image: new Blob(['c'], { type: 'image/png' }) },
  ],
  chosen: 'constellation',
};

function state(screen: ScreenId, extra: Partial<UiState> = {}): UiState {
  return {
    screen,
    loadProgress: 1,
    settings: defaultSettings('ja'),
    progress: { rideCount: 2, seenGuide: false, hiddenFound: [], lastDoor: null },
    xrSupported: false,
    gyroNeedsPermission: false,
    isMobile: false,
    record: null,
    latestPhoto: null,
    shelf: [],
    ...extra,
  };
}

/** hidden 属性・aria-hidden・inert の祖先を持たない要素だけ */
const visible = (el: Element) => !el.closest('[hidden], [aria-hidden="true"], [inert]');
const buttons = () => [...root.querySelectorAll('button')].filter(visible);
const button = (label: string) => {
  const b = buttons().find((x) => x.textContent?.trim() === label || x.getAttribute('aria-label') === label);
  if (!b) throw new Error(`ボタン「${label}」がない。あるのは: ${buttons().map((x) => x.textContent?.trim() || x.getAttribute('aria-label')).join(' / ')}`);
  return b;
};
const text = () =>
  [...root.querySelectorAll('*')]
    .filter((el) => visible(el) && el.children.length === 0)
    .map((el) => el.textContent ?? '')
    .join(' ');

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.append(root);
  const fns = ['enterHome', 'ride', 'skipGuide', 'pause', 'resume', 'alight', 'rideAgain', 'toHome', 'open', 'back', 'setSettings', 'requestGyro', 'savePhoto', 'sharePhoto', 'choosePhoto', 'deletePhoto'] as const;
  cmd = Object.fromEntries(fns.map((f) => [f, vi.fn(async () => true)])) as typeof cmd;
  ui = mountUi(root, cmd as unknown as UiCommands);
});

afterEach(() => {
  ui.dispose();
  root.remove();
  vi.useRealTimers();
});

describe('UI-1 待ち列と入口', () => {
  it('読み込み中は「乗り場へ」を出さず、全部灯ったら出す。押すと enterHome', () => {
    ui.render(state('queue', { loadProgress: 0.5 }));
    expect(() => button(t('queue.enter', 'ja'))).toThrow();
    ui.render(state('queue', { loadProgress: 1 }));
    button(t('queue.enter', 'ja')).click();
    expect(cmd.enterHome).toHaveBeenCalledTimes(1);
  });

  it('入口: タイトルと次の便の切符（第3便）。「乗る」で画面の乗車', () => {
    ui.render(state('home'));
    expect(text()).toContain(t('title', 'ja'));
    expect(text()).toContain('第3便');
    button(t('home.ride', 'ja')).click();
    expect(cmd.ride).toHaveBeenCalledWith('screen');
  });

  it('VR が使える端末でだけ「VRで乗る」を出す', () => {
    ui.render(state('home'));
    expect(() => button(t('home.rideVR', 'ja'))).toThrow();
    ui.render(state('home', { xrSupported: true }));
    button(t('home.rideVR', 'ja')).click();
    expect(cmd.ride).toHaveBeenCalledWith('vr');
  });

  it('入口の他の項目は画面を開く', () => {
    ui.render(state('home'));
    button(t('home.settings', 'ja')).click();
    button(t('home.shelf', 'ja')).click();
    button(t('home.credits', 'ja')).click();
    button(t('home.howto', 'ja')).click();
    expect(cmd.open.mock.calls.map((c) => c[0]).sort()).toEqual(['credits', 'howto', 'settings', 'shelf']);
  });
});

describe('UI-1 乗車前の案内', () => {
  it('3つの案内を出し、飛ばせる', () => {
    ui.render(state('guide'));
    for (const k of ['guide.touch', 'guide.look', 'guide.comfort'] as const) expect(root.textContent).toContain(t(k, 'ja'));
    button(t('guide.skip', 'ja')).click();
    expect(cmd.skipGuide).toHaveBeenCalled();
  });
});

describe('UI-2 乗車中は何も出さない', () => {
  it('乗車中は見える文字も押せるものもない（ポーズの雫は隠れている）', () => {
    ui.render(state('riding'));
    expect(text().trim()).toBe('');
    expect(buttons()).toEqual([]);
  });

  it('マウスを動かしたときだけ雫が2秒浮かび、押すとポーズ', () => {
    ui.render(state('riding'));
    ui.flashPauseDrop();
    button(t('ride.pause', 'ja')).click();
    expect(cmd.pause).toHaveBeenCalled();
    ui.flashPauseDrop();
    vi.advanceTimersByTime(UI.pauseDropVisibleSec * 1000 + 600);
    expect(buttons()).toEqual([]);
  });

  it('0:20 の案内は読み上げにも届く（role=status に「触れると、鳴ります」）', () => {
    ui.render(state('riding'));
    ui.showRideHint();
    vi.advanceTimersByTime(500);
    const live = root.querySelector('[role="status"], [aria-live]');
    expect(live?.textContent).toContain(t('ride.hint', 'ja'));
  });
});

describe('UI-1 ポーズ', () => {
  it('続ける・快適モード・音量・降りる', () => {
    ui.render(state('pause'));
    button(t('pause.continue', 'ja')).click();
    expect(cmd.resume).toHaveBeenCalled();
    button(t('pause.alight', 'ja')).click();
    expect(cmd.alight).toHaveBeenCalled();
    expect(() => button(t('pause.comfort', 'ja'))).not.toThrow();
    expect(() => button(t('pause.volume', 'ja'))).not.toThrow();
  });
});

describe('UI-1 / INT-7 ライドフォトと乗車の記録', () => {
  it('記録（触れた数・選んだ扉・星座・見つけた泡）を出し、点数や順位は出さない', () => {
    ui.render(state('photo', { record, latestPhoto: photo }));
    const s = text();
    expect(s).toContain('42');
    expect(s).toContain(t('door.amber', 'ja'));
    expect(s).toContain(t('record.constellations', 'ja'));
    expect(s).toContain(t('record.hidden', 'ja'));
    expect(s).not.toMatch(/点|スコア|順位|score|rank/i);
  });

  it('保存・共有・もう一度乗る・入口へ', () => {
    ui.render(state('photo', { record, latestPhoto: photo }));
    button(t('photo.save', 'ja')).click();
    expect(cmd.savePhoto).toHaveBeenCalledWith(photo, expect.stringMatching(/^(wide|square)$/));
    button(t('photo.share', 'ja')).click();
    expect(cmd.sharePhoto).toHaveBeenCalled();
    button(t('photo.rideAgain', 'ja')).click();
    expect(cmd.rideAgain).toHaveBeenCalled();
    button(t('photo.toHome', 'ja')).click();
    expect(cmd.toHome).toHaveBeenCalled();
  });

  it('3枚から選べる（choosePhoto）', () => {
    ui.render(state('photo', { record, latestPhoto: photo }));
    const choices = [...root.querySelectorAll('[data-shot]')].filter(visible) as HTMLElement[];
    expect(choices.map((c) => c.dataset.shot).sort()).toEqual(['bloom', 'constellation', 'freeze']);
    choices.find((c) => c.dataset.shot === 'bloom')!.click();
    expect(cmd.choosePhoto).toHaveBeenCalledWith(photo, 'bloom');
  });
});

describe('UI-4 設定と UI-3 言語の切り替え', () => {
  it('5つのタブ（画質・見回し・快適さ・音・表示）', () => {
    ui.render(state('settings'));
    for (const k of ['settings.quality', 'settings.look', 'settings.comfort', 'settings.sound', 'settings.display'] as const) {
      expect(() => button(t(k, 'ja')), k).not.toThrow();
    }
  });

  it('言語を変えると setSettings を呼び、状態が変われば英語で描き直す', () => {
    ui.render(state('settings'));
    const en = root.querySelector('[data-setting="lang"] [data-value="en"], [data-setting="lang"] option[value="en"]') as HTMLElement | null;
    expect(en).not.toBeNull();
    if (en instanceof HTMLOptionElement) {
      const select = en.closest('select')!;
      select.value = 'en';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      en!.click();
    }
    expect(cmd.setSettings).toHaveBeenCalledWith({ lang: 'en' });
    ui.render(state('home', { settings: { ...defaultSettings('en') } }));
    expect(text()).toContain(t('home.ride', 'en'));
  });

  it('戻ると back', () => {
    ui.render(state('settings'));
    button(t('back', 'ja')).click();
    expect(cmd.back).toHaveBeenCalled();
  });
});

describe('UI-1 写真の棚', () => {
  it('写真がなければ空の案内、あれば並べて削除できる', () => {
    ui.render(state('shelf'));
    expect(text()).toContain(t('shelf.empty', 'ja'));
    ui.render(state('shelf', { shelf: [photo] }));
    button(t('shelf.delete', 'ja')).click();
    expect(cmd.deletePhoto).toHaveBeenCalledWith(photo.id);
  });
});
