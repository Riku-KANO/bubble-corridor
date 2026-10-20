// ライドフォトと乗車の記録。降車後、撮った写真がガラスの中に浮かび、ゆっくり回る。
// 写真の下に曇りガラスの小さな札（触れた数・選んだ扉・描いた星座・見つけた泡）。点数や順位は出さない。
// 色は夜明けの金。
import { HIDDEN_BUBBLE_SECTIONS } from '../../config';
import type { SectionId } from '../../contracts/ids';
import { h, replay, setAttr, setClass, setHidden, setText } from '../dom';
import type { Screen, ScreenEnv } from '../screen';
import { createPhotoPane } from './photo-pane';

export function createPhotoScreen(env: ScreenEnv): Screen {
  const { commands } = env;
  const pane = createPhotoPane(env, { choices: true });

  const thanks = h('h2', { class: 'photo-thanks' });
  const cell = (name: string) => {
    const value = h('span', { class: 'cell-value' });
    const label = h('span', { class: 'cell-label' });
    return { value, label, el: h('div', { class: 'cell', 'data-record': name }, label, value) };
  };
  const touches = cell('touches');
  const door = cell('door');
  const constellations = cell('constellations');
  const hidden = cell('hidden');
  const swatch = h('span', { class: 'door-swatch', 'aria-hidden': 'true' });
  const doorValue = h('span', { class: 'cell-door' }, swatch, door.value);
  door.el.replaceChildren(door.label, doorValue);
  const bubbles = HIDDEN_BUBBLE_SECTIONS.map(() => h('span', { class: 'mini-bubble', 'aria-hidden': 'true' }));
  const hiddenValue = h('span', { class: 'cell-bubbles' }, h('span', { class: 'mini-bubbles' }, ...bubbles), hidden.value);
  hidden.el.replaceChildren(hidden.label, hiddenValue);
  const plaque = h('div', { class: 'plaque', role: 'group', hidden: true }, touches.el, door.el, constellations.el, hidden.el);

  const rideAgain = h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => commands.rideAgain() } });
  const toHome = h('button', { type: 'button', class: 'btn', on: { click: () => commands.toHome() } });
  const el = h('section', { class: 'screen screen-photo', 'data-room': 'photo' }, thanks, pane.el, plaque, h('div', { class: 'photo-actions' }, rideAgain, toHome));

  return {
    el,
    update(state) {
      const { tr } = env;
      setText(thanks, tr('photo.thanks'));
      pane.update(state.latestPhoto);
      setText(rideAgain, tr('photo.rideAgain'));
      setText(toHome, tr('photo.toHome'));
      const r = state.record;
      setHidden(plaque, r === null);
      setAttr(plaque, 'aria-label', tr('record.title'));
      setText(touches.label, tr('record.touches'));
      setText(door.label, tr('record.door'));
      setText(constellations.label, tr('record.constellations'));
      setText(hidden.label, tr('record.hidden'));
      if (r) {
        setText(touches.value, String(r.touches));
        setText(door.value, tr(r.door === 'amber' ? 'door.amber' : 'door.lapis'));
        setAttr(swatch, 'data-door', r.door);
        setText(constellations.value, String(r.constellations));
        // 見つけた泡は乗車をまたいで残る。今回見つけた分と合わせて数える
        const found = new Set<SectionId>([...state.progress.hiddenFound, ...r.hiddenFound]);
        HIDDEN_BUBBLE_SECTIONS.forEach((section, i) => setClass(bubbles[i], 'lit', found.has(section)));
        setText(hidden.value, `${found.size} / ${HIDDEN_BUBBLE_SECTIONS.length}`);
      }
    },
    show() {
      replay(el, 'enter');
    },
  };
}
