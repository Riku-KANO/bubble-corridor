// 待ち列（読み込み）。乗り場へ続く薄暗い通路。読み込みが進むにつれて、両側のガラスの灯りが手前から一つずつ灯る。
// 全部灯ったら「乗り場へ」が浮かぶ（ここで音を有効にする）。
import { h, setAttr, setClass, setHidden, setText, setVar } from '../dom';
import type { Screen, ScreenEnv } from '../screen';

/** 通路の両側に並ぶ灯りの組の数 */
const LAMP_PAIRS = 8;

export function createQueueScreen(env: ScreenEnv): Screen {
  const pairs: HTMLElement[][] = [];
  const lamps: HTMLElement[] = [];
  for (let i = 0; i < LAMP_PAIRS; i++) {
    const pair = [-1, 1].map((side) => h('span', { class: 'lamp', 'aria-hidden': 'true', vars: { '--i': i, '--side': side } }, h('span', { class: 'lamp-core' })));
    pairs.push(pair);
    lamps.push(...pair);
  }
  const corridor = h(
    'div',
    { class: 'corridor', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 },
    h('div', { class: 'corridor-floor', 'aria-hidden': 'true' }),
    h('div', { class: 'corridor-door', 'aria-hidden': 'true' }),
    ...lamps,
  );
  const caption = h('p', { class: 'queue-caption' });
  const enter = h('button', { type: 'button', class: 'btn btn-primary btn-float', hidden: true, on: { click: () => env.commands.enterHome() } });
  const el = h('section', { class: 'screen screen-queue', 'data-room': 'queue' }, corridor, h('div', { class: 'queue-foot' }, caption, enter));
  let ready = false;

  return {
    el,
    update(state) {
      const p = Number.isFinite(state.loadProgress) ? Math.min(1, Math.max(0, state.loadProgress)) : 0;
      const done = p >= 1;
      const lit = done ? LAMP_PAIRS : Math.floor(p * LAMP_PAIRS);
      pairs.forEach((pair, i) => pair.forEach((lamp) => setClass(lamp, 'lit', i < lit)));
      setVar(el, '--load', p.toFixed(3));
      setAttr(corridor, 'aria-valuenow', String(Math.round(p * 100)));
      setAttr(corridor, 'aria-label', env.tr('queue.loading'));
      setText(caption, env.tr('queue.waiting'));
      setText(enter, env.tr('queue.enter'));
      setHidden(caption, done);
      setHidden(enter, !done);
      if (done && !ready) enter.focus({ preventScroll: true });
      ready = done;
    },
    show() {
      ready = false;
    },
  };
}
