// 入口や写真から開く画面（棚・設定・乗り方・クレジット）の頭。戻るボタンと見出し。
import { h, setText } from '../dom';
import type { MessageKey } from '../i18n';
import type { ScreenEnv } from '../screen';
import { nextId } from '../widgets';

export interface SubHeader {
  readonly el: HTMLElement;
  readonly titleId: string;
  update(): void;
  /** 戻るボタンにフォーカスを置く（キーボードで開いたとき、すぐ戻れるように） */
  focus(): void;
}

export function createSubHeader(env: ScreenEnv, titleKey: MessageKey): SubHeader {
  const titleId = nextId('title');
  const back = h('button', { type: 'button', class: 'btn btn-quiet back', on: { click: () => env.commands.back() } });
  const title = h('h2', { class: 'sub-title', id: titleId });
  return {
    el: h('header', { class: 'sub-header' }, back, title),
    titleId,
    focus: () => back.focus({ preventScroll: true }),
    update() {
      setText(back, env.tr('back'));
      setText(title, env.tr(titleKey));
    },
  };
}
