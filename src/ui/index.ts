// 画面（DOM）。状態（UiState）を読んで表示し、UiCommands を呼ぶだけ。乗車の処理は書かない。
// 素材はガラスだけ（曇りガラス・透明ガラス・泡の膜・指でなぞった文字）。乗車中は見える文字も押せるものもゼロ。
// 画面ごとの作りは screens/、見た目は src/styles/。生の HTML は挿入しない（dom.ts の h()）。
import '../styles/tokens.css';
import '../styles/glass.css';
import '../styles/screens.css';
import { UI } from '../config';
import type { Lang } from '../contracts/ids';
import type { ScreenId, UiCommands, UiState } from '../contracts/ui';
import { BlobUrls } from './blobs';
import { h, setAttr, setFlag } from './dom';
import { t } from './i18n';
import type { Screen, ScreenEnv } from './screen';
import { createCreditsScreen } from './screens/credits';
import { createGuideScreen } from './screens/guide';
import { createHomeScreen } from './screens/home';
import { createHowtoScreen } from './screens/howto';
import { createPauseScreen } from './screens/pause';
import { createPhotoScreen } from './screens/photo';
import { createQueueScreen } from './screens/queue';
import { createRidingScreen } from './screens/riding';
import { createSettingsScreen } from './screens/settings';
import { createShelfScreen } from './screens/shelf';
import { timing } from './transitions';

export { defaultSettings, loadProgress, loadSettings, saveProgress, saveSettings } from './store';

export interface UiHandle {
  /** 状態が変わるたびに呼ぶ（差分だけを反映する） */
  render(state: UiState): void;
  /** 0:20 頃に一度だけ、泡の内側の曇りに「触れると、鳴ります」と書いて消す */
  showRideHint(): void;
  /** 乗車中にマウスを動かしたとき、隅に小さな雫（ポーズ）を2秒間浮かべる */
  flashPauseDrop(): void;
  dispose(): void;
}

/** 長押しの間に指が動いてよい範囲（px）。これを超えたら見回しのドラッグとみなす。設計書に値がないので仮 */
const PRESS_SLOP_PX = 10;

const SUB_SCREENS: readonly ScreenId[] = ['shelf', 'settings', 'howto', 'credits'];

export function mountUi(root: HTMLElement, commands: UiCommands): UiHandle {
  const ui = h('div', { class: 'ui' });
  root.append(ui);

  let lang: Lang = 'ja';
  let vrPending = false;
  const blobs = new BlobUrls();
  const env: ScreenEnv = {
    // VR で乗るときの切り替えは「白い霧」の長さにする。UiState に乗り方がないので、押されたボタンで覚える
    commands: {
      ...commands,
      ride(mode) {
        vrPending = mode === 'vr';
        commands.ride(mode);
      },
    },
    tr: (key, vars) => t(key, lang, vars),
    blobUrl: (blob) => blobs.urlFor(blob),
  };

  const riding = createRidingScreen(env);
  const screens: Record<ScreenId, Screen> = {
    queue: createQueueScreen(env),
    home: createHomeScreen(env),
    guide: createGuideScreen(env),
    riding,
    pause: createPauseScreen(env),
    photo: createPhotoScreen(env),
    shelf: createShelfScreen(env),
    settings: createSettingsScreen(env),
    howto: createHowtoScreen(env),
    credits: createCreditsScreen(env),
  };
  // 乗車中の画面を DOM の先頭に置く: 最初の role="status" が乗車中の案内になる（テストと、status を先頭から探す道具のため）
  const order = ['riding', ...(Object.keys(screens) as ScreenId[]).filter((id) => id !== 'riding')] as ScreenId[];
  for (const id of order) {
    const screen = screens[id];
    screen.el.hidden = true;
    ui.append(screen.el);
  }

  // ── 画面の切り替え ──
  let current: ScreenId | null = null;
  const leaving = new Map<ScreenId, number>();
  /** 現れ始めるまで待っている画面の、触れる状態にするタイマー */
  const waiting = new Map<ScreenId, number>();

  function leave(id: ScreenId, sec: number): void {
    const screen = screens[id];
    window.clearTimeout(waiting.get(id));
    waiting.delete(id);
    screen.hide?.();
    // 消える間も触れず、読み上げにも出さない（動きが終わったら hidden にする）。フォーカスは先に手放す
    if (document.activeElement instanceof HTMLElement && screen.el.contains(document.activeElement)) document.activeElement.blur();
    screen.el.setAttribute('inert', '');
    screen.el.setAttribute('aria-hidden', 'true');
    screen.el.classList.remove('is-in');
    screen.el.classList.add('is-leaving');
    screen.el.style.setProperty('--out', `${sec}s`);
    const done = (): void => {
      leaving.delete(id);
      if (current !== id) screen.el.hidden = true;
    };
    window.clearTimeout(leaving.get(id));
    if (sec <= 0) done();
    else leaving.set(id, window.setTimeout(done, sec * 1000));
  }

  function enter(id: ScreenId, delaySec: number, sec: number): void {
    const screen = screens[id];
    window.clearTimeout(leaving.get(id));
    leaving.delete(id);
    const el = screen.el;
    el.style.setProperty('--in', `${sec}s`);
    el.style.setProperty('--delay', `${delaySec}s`);
    el.hidden = false;
    el.classList.remove('is-leaving');
    // まだ見えない間（delay）は触れさせない。見えない案内を押して飛ばしてしまう、を防ぐ
    const activate = (): void => {
      window.clearTimeout(waiting.get(id));
      waiting.delete(id);
      if (current !== id) return;
      el.removeAttribute('inert');
      el.removeAttribute('aria-hidden');
      screen.focus?.();
    };
    window.clearTimeout(waiting.get(id));
    if (delaySec > 0) {
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
      waiting.set(id, window.setTimeout(activate, delaySec * 1000));
    }
    void el.offsetWidth; // 隠れていた要素の現れる動きを始めるため
    el.classList.add('is-in');
    screen.show?.(delaySec);
    if (delaySec <= 0) activate();
  }

  function switchTo(next: ScreenId): void {
    const prev = current;
    const vr = vrPending;
    if ((next === 'riding' && prev !== 'pause') || next === 'home') vrPending = false;
    current = next;
    const tm = timing(prev, next, vr);
    if (prev !== null) leave(prev, tm.leave);
    enter(next, prev === null ? 0 : tm.delay, tm.enter);
    ui.dataset.screen = next;
  }

  // ── 状態の反映 ──
  const keepBlobs = new Set<Blob>();
  function render(state: UiState): void {
    lang = state.settings.lang;
    setAttr(ui, 'lang', lang);
    setFlag(ui, 'data-calm', state.settings.reducedFlash);
    if (state.screen !== current) {
      // 書く演出は文字の長さから時間を決めるので、表示の前に文言を入れておく
      screens[state.screen].update(state);
      switchTo(state.screen);
    }
    screens[state.screen].update(state);

    // 画面に出していない写真の URL は手放す
    keepBlobs.clear();
    for (const r of [state.latestPhoto, ...state.shelf]) for (const s of r?.shots ?? []) keepBlobs.add(s.image);
    blobs.prune(keepBlobs);
  }

  // ── 入力 ──
  // 押した場所から広がる輪（0.1 秒以内に必ず動きで応える）
  const onPointerDown = (e: PointerEvent): void => {
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>('.btn, .chip, .seg-opt, .tab, .orb') : null;
    if (!target || target.hasAttribute('disabled')) return;
    const box = target.getBoundingClientRect();
    const ring = h('span', { class: 'ripple', 'aria-hidden': 'true', vars: { '--x': `${e.clientX - box.left}px`, '--y': `${e.clientY - box.top}px` } });
    target.append(ring);
    window.setTimeout(() => ring.remove(), 700);
  };
  ui.addEventListener('pointerdown', onPointerDown);

  // 入口・棚・設定などは Esc で戻る（乗車中とポーズの Esc は app が受け持つ）
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && current !== null && SUB_SCREENS.includes(current) && !e.defaultPrevented) env.commands.back();
  };
  document.addEventListener('keydown', onKeyDown);

  // 画面の長押しでポーズ。見回しのドラッグ（動かした）と、雫・ボタン（ui の中）は数えない
  let pressTimer = 0;
  let pressAt: { readonly x: number; readonly y: number } | null = null;
  const stopPress = (): void => {
    window.clearTimeout(pressTimer);
    pressAt = null;
  };
  const onPressStart = (e: PointerEvent): void => {
    stopPress();
    // マウスには Esc と雫がある。長押しは指（タッチ・ペン）のため。見回しのドラッグで止めてしまわない
    if (current !== 'riding' || !e.isPrimary || e.pointerType === 'mouse' || (e.target instanceof Node && ui.contains(e.target))) return;
    pressAt = { x: e.clientX, y: e.clientY };
    pressTimer = window.setTimeout(() => {
      pressAt = null;
      if (current === 'riding') env.commands.pause();
    }, UI.longPressSec * 1000);
  };
  const onPressMove = (e: PointerEvent): void => {
    if (pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > PRESS_SLOP_PX) stopPress();
  };
  // 長押しでメニュー（コンテキストメニュー）が割り込まないようにする（乗車中だけ）
  const onContextMenu = (e: Event): void => {
    if (current === 'riding' && !(e.target instanceof Node && ui.contains(e.target))) e.preventDefault();
  };
  root.addEventListener('contextmenu', onContextMenu);
  root.addEventListener('pointerdown', onPressStart);
  root.addEventListener('pointermove', onPressMove);
  root.addEventListener('pointerup', stopPress);
  root.addEventListener('pointercancel', stopPress);

  return {
    render,
    showRideHint: () => riding.showHint(),
    flashPauseDrop: () => riding.flashDrop(),
    dispose() {
      stopPress();
      root.removeEventListener('contextmenu', onContextMenu);
      root.removeEventListener('pointerdown', onPressStart);
      root.removeEventListener('pointermove', onPressMove);
      root.removeEventListener('pointerup', stopPress);
      root.removeEventListener('pointercancel', stopPress);
      document.removeEventListener('keydown', onKeyDown);
      for (const id of leaving.values()) window.clearTimeout(id);
      leaving.clear();
      for (const id of waiting.values()) window.clearTimeout(id);
      waiting.clear();
      for (const id of order) {
        screens[id].hide?.();
        screens[id].dispose?.();
      }
      blobs.dispose();
      ui.remove();
    },
  };
}
