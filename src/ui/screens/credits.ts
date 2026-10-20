// クレジット。書体と描画の部品の出どころ。
import { h, setText } from '../dom';
import type { Screen, ScreenEnv } from '../screen';
import { createSubHeader } from './sub-header';

export function createCreditsScreen(env: ScreenEnv): Screen {
  const header = createSubHeader(env, 'credits.title');
  const name = h('p', { class: 'credits-name' });
  const subtitle = h('p', { class: 'credits-sub' });
  const lines = (['credits.tagline', 'credits.music', 'credits.fonts', 'credits.engine'] as const).map((key) => ({ key, el: h('p', { class: 'credits-line' }) }));
  const el = h('section', { class: 'screen screen-credits', 'data-room': 'credits' }, header.el, h('div', { class: 'credits-panel glass-panel' }, name, subtitle, ...lines.map((l) => l.el)));
  return {
    el,
    update() {
      header.update();
      setText(name, env.tr('title'));
      setText(subtitle, env.tr('subtitle'));
      for (const l of lines) setText(l.el, env.tr(l.key));
    },
    focus: () => header.focus(),
  };
}
