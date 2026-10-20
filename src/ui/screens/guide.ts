// 乗車前の案内。曇りガラスの立て札に、3つの案内が指で書かれていく。
// 6秒で自動的に進む（app が進める）。どこをクリックしても飛ばせる。2回目以降は出さない（flow が決める）。
import { UI } from '../../config';
import { h, replay, setAttr, setText } from '../dom';
import { createFog } from '../fog';
import type { Screen, ScreenEnv } from '../screen';
import { armWrites, disarmWrites, GUIDE } from '../write';

export function createGuideScreen(env: ScreenEnv): Screen {
  const lines = (['guide.touch', 'guide.look', 'guide.comfort'] as const).map((key) => h('p', { class: 'guide-line write', 'data-key': key }));
  const board = h('div', { class: 'board', role: 'group' }, h('div', { class: 'board-lines' }, ...lines));
  const timer = h('span', { class: 'guide-timer', 'aria-hidden': 'true', vars: { '--sec': `${UI.preRideGuideSec}s` } });
  const skip = h('button', { type: 'button', class: 'btn btn-quiet guide-skip', on: { click: () => env.commands.skipGuide() } });
  const el = h('section', { class: 'screen screen-guide', 'data-room': 'guide' }, h('div', { class: 'board-wrap' }, board, h('span', { class: 'board-post', 'aria-hidden': 'true' })), h('div', { class: 'guide-foot' }, timer, skip));
  const fog = createFog(board, { tint: 'rgba(150, 172, 205, 0.5)' });

  // どこをクリックしても飛ばせる（「飛ばす」のボタンは自分で呼ぶ）
  el.addEventListener('click', (e) => {
    if (e.target instanceof Node && skip.contains(e.target)) return;
    env.commands.skipGuide();
  });

  return {
    el,
    update() {
      setText(skip, env.tr('guide.skip'));
      setAttr(board, 'aria-label', env.tr('guide.label'));
      for (const line of lines) setText(line, env.tr(line.dataset.key as 'guide.touch'));
    },
    show(delaySec) {
      fog.show(0.8);
      armWrites(lines, 0.3 + delaySec, 0.12, GUIDE);
      replay(timer, 'run');
      skip.focus({ preventScroll: true });
    },
    hide() {
      disarmWrites(lines);
      fog.hide(0.4);
    },
    dispose() {
      fog.dispose();
    },
  };
}
