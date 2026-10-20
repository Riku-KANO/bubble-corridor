// 乗車中。見える文字も押せるものもゼロ（UI-2）。
//  - マウスを動かしたときだけ、隅に小さな雫（ポーズ）が 2 秒浮かぶ
//  - 0:20 頃に一度だけ、泡の内側の曇りに「触れると、鳴ります」と書いて消える。同じ文言を role="status" にも入れる
// 雫と案内の層は、出ていないときは hidden にする（aria-hidden だけにしない: タブで辿れてしまうため）。
import { UI } from '../../config';
import { h, setAttr, setHidden, setText, s } from '../dom';
import { createFog } from '../fog';
import type { Screen, ScreenEnv } from '../screen';
import { armWrite, writeSeconds } from '../write';

export interface RidingScreen extends Screen {
  /** 0:20 頃に一度だけ、曇りに書いて消す */
  showHint(): void;
  /** マウスを動かしたとき、雫を 2 秒浮かべる */
  flashDrop(): void;
}

/** 案内を曇りに書いてから消えるまでの流れ（秒） */
const HINT = { fogIn: 0.8, writeAt: 0.4, hold: 2.8, dissolve: 1.2, clearLive: 1.5 } as const;
/** 雫が消えるときの動きの長さ（秒） */
const DROP_FADE_SEC = 0.3;

export function createRidingScreen(env: ScreenEnv): RidingScreen {
  const live = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const hintText = h('p', { class: 'hint-text write' });
  const hint = h('div', { class: 'ride-hint', hidden: true, 'aria-hidden': 'true' }, h('div', { class: 'hint-fog' }, hintText));
  const fog = createFog(hint.firstElementChild as HTMLElement, { tint: 'rgba(98, 124, 168, 0.55)' });

  const drop = h(
    'button',
    { type: 'button', class: 'drop', hidden: true, on: { click: () => env.commands.pause() } },
    s(
      'svg',
      { viewBox: '0 0 24 30', 'aria-hidden': 'true', focusable: 'false' },
      s('path', { class: 'drop-body', d: 'M12 1.5C12 1.5 3.2 12 3.2 18.6a8.8 8.8 0 0 0 17.6 0C20.8 12 12 1.5 12 1.5Z' }),
      s('path', { class: 'drop-shine', d: 'M8 17.5a4.2 4.2 0 0 0 3.2 4.1' }),
    ),
  );
  const el = h('section', { class: 'screen screen-riding', 'data-room': 'riding' }, live, hint, drop);

  let active = false;
  const timers = new Set<number>();
  let dropTimer = 0;
  let hintTimers: number[] = [];
  const later = (fn: () => void, sec: number): number => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      fn();
    }, sec * 1000);
    timers.add(id);
    return id;
  };
  const cancel = (id: number): void => {
    window.clearTimeout(id);
    timers.delete(id);
  };

  function hideDropNow(): void {
    cancel(dropTimer);
    drop.classList.remove('is-on');
    setHidden(drop, true);
  }

  function armDropTimer(): void {
    cancel(dropTimer);
    dropTimer = later(() => {
      drop.classList.remove('is-on');
      dropTimer = later(() => setHidden(drop, true), DROP_FADE_SEC);
    }, UI.pauseDropVisibleSec);
  }

  // 雫を狙っている間は消さない
  drop.addEventListener('pointerenter', () => cancel(dropTimer));
  drop.addEventListener('pointerleave', () => {
    if (!drop.hidden) armDropTimer();
  });

  function endHint(): void {
    for (const id of hintTimers) cancel(id);
    hintTimers = [];
    fog.hide(0.3);
    hint.classList.remove('is-dissolving');
    setHidden(hint, true);
    setText(live, '');
  }

  return {
    el,
    update() {
      setAttr(drop, 'aria-label', env.tr('ride.pause'));
    },
    show() {
      active = true;
    },
    hide() {
      active = false;
      hideDropNow();
      endHint();
    },
    flashDrop() {
      if (!active) return;
      setAttr(drop, 'aria-label', env.tr('ride.pause'));
      setHidden(drop, false);
      void drop.offsetWidth; // 隠れていた要素が現れる動きを始めるため
      drop.classList.add('is-on');
      armDropTimer();
    },
    showHint() {
      if (!active) return;
      endHint();
      const message = env.tr('ride.hint');
      // 読み上げには文言をすぐ渡し、見える側は曇りが広がってから書く
      setText(live, message);
      setText(hintText, message);
      setHidden(hint, false);
      fog.show(HINT.fogIn);
      const dissolveAt = HINT.writeAt + writeSeconds(message) + HINT.hold;
      hintTimers.push(
        later(() => armWrite(hintText, 0), HINT.writeAt),
        later(() => {
          hint.classList.add('is-dissolving');
          fog.hide(HINT.dissolve);
        }, dissolveAt),
        later(() => {
          setHidden(hint, true);
          hint.classList.remove('is-dissolving');
          hintText.classList.remove('is-writing');
        }, dissolveAt + HINT.dissolve),
        later(() => setText(live, ''), dissolveAt + HINT.dissolve + HINT.clearLive),
      );
    },
    dispose() {
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
      fog.dispose();
    },
  };
}
