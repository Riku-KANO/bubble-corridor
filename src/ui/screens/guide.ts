// 乗車前の案内。曇りガラスの立て札に、3つの案内が指で書かれていく。
// 6秒で自動的に進む（app が進める）。どこをクリックしても飛ばせる。2回目以降は出さない（flow が決める）。
// 端末の傾きの許可が要るスマートフォン（iOS）では、ここで「傾けて見回す」を出す（許可は押した操作の中で求める）。
import { UI } from '../../config';
import { h, replay, setAttr, setHidden, setText } from '../dom';
import { createFog } from '../fog';
import type { Screen, ScreenEnv } from '../screen';
import { nextId } from '../widgets';
import { armWrites, disarmWrites, GUIDE } from '../write';

/** 現れてから、最初の行を書き始めるまでの間（秒）は、クリックを受け付けない */
const FIRST_LINE_SEC = 0.3;

export function createGuideScreen(env: ScreenEnv): Screen {
  const { commands } = env;
  const keys = ['guide.touch', 'guide.look', 'guide.comfort'] as const;
  const ids = keys.map(() => nextId('guide'));
  const lines = keys.map((key, i) => h('p', { class: 'guide-line write', id: ids[i], 'data-key': key }));
  const board = h('div', { class: 'board', role: 'group' }, h('div', { class: 'board-lines' }, ...lines));
  const timer = h('span', { class: 'guide-timer', 'aria-hidden': 'true', vars: { '--sec': `${UI.preRideGuideSec}s` } });
  // 3つの案内は読み上げにも届ける（最初にフォーカスが置かれる「飛ばす」の説明として読まれる）
  const skip = h('button', { type: 'button', class: 'btn btn-quiet guide-skip', 'aria-describedby': ids.join(' '), on: { click: () => ready() && commands.skipGuide() } });
  const gyro = h('button', { type: 'button', class: 'btn btn-secondary guide-gyro', hidden: true, on: { click: () => askGyro() } });
  const note = h('p', { class: 'guide-note sr-only', role: 'status' });
  const foot = h('div', { class: 'guide-foot' }, timer, gyro, note, skip);
  const el = h('section', { class: 'screen screen-guide', 'data-room': 'guide' }, h('div', { class: 'board-wrap' }, board, h('span', { class: 'board-post', 'aria-hidden': 'true' })), foot);
  const fog = createFog(board, { tint: 'rgba(150, 172, 205, 0.5)' });

  /** 傾きの許可の結果。idle はまだ聞いていない */
  let gyroResult: 'idle' | 'granted' | 'denied' = 'idle';
  let wantsGyro = false;
  let clickableAt = 0;
  const ready = (): boolean => Date.now() >= clickableAt;

  // 現れる途中の案内を押して飛ばしてしまわないよう、最初の行を書き始めるまでは受け付けない。
  // どこをクリックしても飛ばせる（ボタンは自分の処理を持つ）
  el.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('.btn')) return;
    if (ready()) commands.skipGuide();
  });

  function askGyro(): void {
    if (!ready()) return;
    // iOS では、許可の問い合わせはユーザー操作の中で呼ぶ。結果を待たずに案内は進んでよい
    const request = Promise.resolve(commands.requestGyro());
    void request.then(
      (ok) => finishGyro(ok),
      () => finishGyro(false),
    );
  }

  function finishGyro(ok: boolean): void {
    gyroResult = ok ? 'granted' : 'denied';
    if (ok) commands.setSettings({ gyro: true });
    // 押したボタンは隠れるので、フォーカスを「飛ばす」へ移す（body に落とさない）
    const hadFocus = document.activeElement === gyro;
    paintGyro();
    if (hadFocus) skip.focus();
  }

  function paintGyro(): void {
    const { tr } = env;
    setHidden(gyro, !wantsGyro || gyroResult !== 'idle');
    // 知らせ（role=status）は表に置いたまま文言だけ入れ替える（hidden を外すのと同時に入れると読み上げに届かない）
    note.classList.toggle('sr-only', gyroResult === 'idle');
    setText(note, gyroResult === 'granted' ? tr('guide.gyro.on') : gyroResult === 'denied' ? tr('look.gyro.denied') : '');
  }

  return {
    el,
    update(state) {
      setText(skip, env.tr('guide.skip'));
      setText(gyro, env.tr('guide.gyro'));
      setAttr(board, 'aria-label', env.tr('guide.label'));
      for (const line of lines) setText(line, env.tr(line.dataset.key as 'guide.touch'));
      // 設計書「スマートフォンの傾きによる見回しは、最初に許可を求める」: まだ使っていないスマートフォンで尋ねる
      // （iOS は許可の問い合わせ、Android は許可なしでそのまま有効になる）
      wantsGyro = state.isMobile && !state.settings.gyro;
      paintGyro();
    },
    show(delaySec) {
      clickableAt = delaySec > 0 ? Date.now() + (delaySec + FIRST_LINE_SEC) * 1000 : 0;
      gyroResult = 'idle';
      paintGyro();
      fog.show(0.8);
      armWrites(lines, FIRST_LINE_SEC + delaySec, 0.12, GUIDE);
      replay(timer, 'run');
    },
    focus() {
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
