// ポーズ。泡の内側に息を吹きかけたような曇りが広がり、項目が書かれる。ゴンドラも音楽も止まる（app が止める）。
// 項目: 続ける / 快適モード / 音量 / 降りる。
import { TRANSITION_SEC } from '../../config';
import { h, setAttr, setHidden, setText } from '../dom';
import { createFog } from '../fog';
import type { Screen, ScreenEnv } from '../screen';
import { sliderRow } from '../widgets';
import { armWrite, disarmWrites, QUICK } from '../write';
import type { Settings } from '../../contracts/ui';

export function createPauseScreen(env: ScreenEnv): Screen {
  const { commands } = env;
  let latest: Settings | null = null;
  let gentle = false;

  const heading = h('h2', { class: 'pause-title write', id: 'pause-title' });
  const resume = h('button', { type: 'button', class: 'write-item write', on: { click: () => commands.resume() } });
  const comfort = h('button', { type: 'button', class: 'write-item write', 'aria-pressed': 'false', on: { click: () => commands.setSettings({ comfort: gentle ? 'standard' : 'gentle' }) } });
  const comfortState = h('span', { class: 'pause-state' });
  const volume = h('button', { type: 'button', class: 'write-item write', 'aria-expanded': 'false', on: { click: () => toggleVolume() } });
  const master = sliderRow({
    setting: 'pause-volume',
    label: 'sound.master',
    min: 0,
    max: 1,
    step: 0.05,
    get: (s) => s.volumes.master,
    pick: (v) => {
      if (latest) commands.setSettings({ volumes: { ...latest.volumes, master: v } });
    },
    format: (v) => `${Math.round(v * 100)}%`,
  });
  const volumeBox = h('div', { class: 'pause-volume', hidden: true }, master.el);
  const alight = h('button', { type: 'button', class: 'write-item write', on: { click: () => commands.alight() } });
  const items = [resume, comfort, volume, alight];

  const menu = h(
    'ul',
    { class: 'pause-menu' },
    h('li', null, resume),
    h('li', { class: 'pause-row' }, comfort, comfortState),
    h('li', null, volume, volumeBox),
    h('li', null, alight),
  );
  const panel = h('div', { class: 'pause-panel', role: 'group', 'aria-labelledby': 'pause-title' }, heading, menu);
  const el = h('section', { class: 'screen screen-pause', 'data-room': 'pause' }, panel);
  const fog = createFog(el, { tint: 'rgba(104, 128, 166, 0.55)' });

  function toggleVolume(): void {
    const open = volumeBox.hidden;
    setHidden(volumeBox, !open);
    setAttr(volume, 'aria-expanded', String(open));
  }

  return {
    el,
    update(state) {
      const { tr } = env;
      latest = state.settings;
      gentle = state.settings.comfort === 'gentle';
      setText(heading, tr('pause.title'));
      setText(resume, tr('pause.continue'));
      setText(comfort, tr('pause.comfort'));
      setAttr(comfort, 'aria-pressed', String(gentle));
      setText(comfortState, tr(gentle ? 'comfort.gentle' : 'comfort.standard'));
      setText(volume, tr('pause.volume'));
      setText(alight, tr('pause.alight'));
      master.sync(state.settings, tr);
    },
    show(delaySec) {
      fog.show(TRANSITION_SEC.pause);
      setHidden(volumeBox, true);
      setAttr(volume, 'aria-expanded', 'false');
      // 項目は少しずつずらして、ほぼ同時に書き始める（すぐ押せるように）
      [heading, ...items].forEach((el, i) => armWrite(el, delaySec + 0.1 + i * 0.13, QUICK));
      resume.focus({ preventScroll: true });
    },
    hide() {
      disarmWrites([heading, ...items]);
      fog.hide(TRANSITION_SEC.resume);
    },
    dispose() {
      fog.dispose();
    },
  };
}
