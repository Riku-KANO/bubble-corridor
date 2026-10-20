// 画面（DOM）。状態（UiState）を読んで表示し、UiCommands を呼ぶだけ。乗車の処理は書かない。
// STUB: 署名は確定。中身は ui 担当が本実装に置き換える。今は最小のボタンだけを出す。
import type { UiCommands, UiState } from '../contracts/ui';

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

export function mountUi(root: HTMLElement, commands: UiCommands): UiHandle {
  // STUB
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:16px;bottom:16px;display:flex;gap:8px;font:16px sans-serif;z-index:10';
  root.append(box);
  const button = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  let last = '';
  return {
    render(state) {
      const key = `${state.screen}:${state.loadProgress >= 1}`;
      if (key === last) return;
      last = key;
      box.replaceChildren();
      if (state.screen === 'queue' && state.loadProgress >= 1) box.append(button('乗り場へ', () => commands.enterHome()));
      if (state.screen === 'home') box.append(button('乗る', () => commands.ride('screen')));
      if (state.screen === 'guide') box.append(button('飛ばす', () => commands.skipGuide()));
      if (state.screen === 'riding') box.append(button('ポーズ', () => commands.pause()));
      if (state.screen === 'pause') box.append(button('続ける', () => commands.resume()), button('降りる', () => commands.alight()));
      if (state.screen === 'photo') box.append(button('もう一度乗る', () => commands.rideAgain()), button('入口へ', () => commands.toHome()));
    },
    showRideHint() {},
    flashPauseDrop() {},
    dispose() {
      box.remove();
    },
  };
}
