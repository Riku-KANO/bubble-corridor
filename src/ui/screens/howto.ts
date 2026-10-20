// 乗り方（画面 / VR）。操作は「見回す」「触れる」「選ぶ」の3つだけで、どれも任意。
import { h, setText } from '../dom';
import type { MessageKey } from '../i18n';
import type { Screen, ScreenEnv } from '../screen';
import { createSubHeader } from './sub-header';

type Op = 'look' | 'touch' | 'choose';
const OPS: readonly Op[] = ['look', 'touch', 'choose'];

export function createHowtoScreen(env: ScreenEnv): Screen {
  const header = createSubHeader(env, 'howto.title');
  const text = (key: MessageKey) => ({ key, el: h('dd', { class: 'howto-text' }) });

  const screenHead = h('h3', { class: 'howto-head' });
  const vrHead = h('h3', { class: 'howto-head' });
  const screenCol = OPS.map((op) => ({ op, label: h('dt', { class: 'howto-op' }), body: text(`howto.screen.${op}` as const) }));
  const vrCol = OPS.map((op) => ({ op, label: h('dt', { class: 'howto-op' }), body: text(`howto.vr.${op}` as const) }));
  const gazeLabel = h('dt', { class: 'howto-op' });
  const gazeBody = text('howto.gaze');

  const column = (head: HTMLElement, rows: typeof screenCol) =>
    h('section', { class: 'howto-col' }, head, h('dl', { class: 'howto-list' }, ...rows.flatMap((r) => [r.label, r.body.el])));
  const pause = h('p', { class: 'howto-note' });
  const note = h('p', { class: 'howto-note howto-note-soft' });
  const el = h(
    'section',
    { class: 'screen screen-howto', 'data-room': 'howto' },
    header.el,
    h('div', { class: 'howto-panel glass-panel' }, h('div', { class: 'howto-cols' }, column(screenHead, screenCol), column(vrHead, vrCol)), h('dl', { class: 'howto-list howto-gaze' }, gazeLabel, gazeBody.el), pause, note),
  );

  return {
    el,
    update() {
      const { tr } = env;
      header.update();
      setText(screenHead, tr('howto.screen'));
      setText(vrHead, tr('howto.vr'));
      for (const col of [screenCol, vrCol]) {
        for (const r of col) {
          setText(r.label, tr(`howto.op.${r.op}` as const));
          setText(r.body.el, tr(r.body.key));
        }
      }
      setText(gazeLabel, tr('howto.op.gaze'));
      setText(gazeBody.el, tr(gazeBody.key));
      setText(pause, tr('howto.pause'));
      setText(note, tr('howto.note'));
    },
    focus: () => header.focus(),
  };
}
