// 設定。曇りガラスのパネル。タブは 画質 / 見回し / 快適さ / 音 / 表示。変更は即時反映する（setSettings → app が保存して反映）。
import { CAMERA, INTERACTION } from '../../config';
import type { Settings } from '../../contracts/ui';
import { arrowNav, noteRow, segmentedRow, sliderRow, switchRow, nextId, type Row } from '../widgets';
import { h, setAttr, setHidden, setText } from '../dom';
import type { MessageKey } from '../i18n';
import type { Screen, ScreenEnv, Tr } from '../screen';
import { createSubHeader } from './sub-header';

type TabId = 'quality' | 'look' | 'comfort' | 'sound' | 'display';
const TABS: readonly { readonly id: TabId; readonly label: MessageKey }[] = [
  { id: 'quality', label: 'settings.quality' },
  { id: 'look', label: 'settings.look' },
  { id: 'comfort', label: 'settings.comfort' },
  { id: 'sound', label: 'settings.sound' },
  { id: 'display', label: 'settings.display' },
];

const percent = (v: number): string => `${Math.round(v * 100)}%`;

export function createSettingsScreen(env: ScreenEnv): Screen {
  const { commands } = env;
  const header = createSubHeader(env, 'settings.title');
  let latest: Settings | null = null;
  let isMobile = false;
  let gyroDenied = false;
  const set = (patch: Partial<Settings>): void => commands.setSettings(patch);
  const volume = (key: keyof Settings['volumes'], label: MessageKey): Row =>
    sliderRow({
      setting: `volume.${key}`,
      label,
      min: 0,
      max: 1,
      step: 0.05,
      get: (s) => s.volumes[key],
      pick: (v) => latest && set({ volumes: { ...latest.volumes, [key]: v } }),
      format: percent,
    });

  const gyro = switchRow({
    setting: 'gyro',
    label: 'look.gyro',
    get: (s) => s.gyro,
    pick: (on) => {
      if (!on) return set({ gyro: false });
      // 端末の傾きは許可制。断られたらドラッグのまま（off）にする
      void Promise.resolve(commands.requestGyro()).then(
        (ok) => {
          gyroDenied = !ok;
          setHidden(gyroNote, !gyroDenied);
          set({ gyro: ok });
        },
        () => {
          gyroDenied = true;
          setHidden(gyroNote, false);
          set({ gyro: false });
        },
      );
    },
  });
  const gyroNote = h('p', { class: 'row-note', hidden: true });
  const comfortNote = noteRow();
  const soundNote = noteRow();

  const rows: Record<TabId, Row[]> = {
    quality: [
      segmentedRow({
        setting: 'quality',
        label: 'quality.preset',
        options: [
          { value: 'auto', label: 'opt.auto' },
          { value: 'low', label: 'opt.low' },
          { value: 'medium', label: 'opt.medium' },
          { value: 'high', label: 'opt.high' },
        ],
        get: (s) => s.quality,
        pick: (quality) => set({ quality }),
      }),
    ],
    look: [
      segmentedRow({
        setting: 'lookMode',
        label: 'look.mode',
        options: [
          { value: 'drag', label: 'look.drag' },
          { value: 'follow', label: 'look.follow' },
        ],
        get: (s) => s.lookMode,
        pick: (lookMode) => set({ lookMode }),
      }),
      gyro,
      sliderRow({ setting: 'fov', label: 'look.fov', min: CAMERA.fovMinDeg, max: CAMERA.fovMaxDeg, step: 1, get: (s) => s.fov, pick: (fov) => set({ fov }), format: (v) => `${Math.round(v)}°` }),
      switchRow({ setting: 'autoRecenter', label: 'look.recenter', get: (s) => s.autoRecenter, pick: (autoRecenter) => set({ autoRecenter }) }),
      segmentedRow({
        setting: 'gazeDwellSec',
        label: 'look.gaze',
        options: INTERACTION.gazeDwellChoices.map((n) => ({ value: n, label: { key: 'unit.sec' as const, vars: { n: n.toFixed(1) } } })),
        get: (s) => s.gazeDwellSec,
        pick: (gazeDwellSec) => set({ gazeDwellSec }),
      }),
    ],
    comfort: [
      segmentedRow({
        setting: 'comfort',
        label: 'home.comfort',
        options: [
          { value: 'standard', label: 'comfort.standard' },
          { value: 'gentle', label: 'comfort.gentle' },
        ],
        get: (s) => s.comfort,
        pick: (comfort) => set({ comfort }),
      }),
      switchRow({ setting: 'reducedFlash', label: 'comfort.reducedFlash', desc: 'comfort.reducedFlash.desc', get: (s) => s.reducedFlash, pick: (reducedFlash) => set({ reducedFlash }) }),
      sliderRow({ setting: 'vignette', label: 'comfort.vignette', min: 0, max: 1, step: 0.05, get: (s) => s.vignette, pick: (vignette) => set({ vignette }), format: percent }),
      segmentedRow({
        setting: 'xrPosture',
        label: 'comfort.posture',
        options: [
          { value: 'seated', label: 'posture.seated' },
          { value: 'standing', label: 'posture.standing' },
        ],
        get: (s) => s.xrPosture,
        pick: (xrPosture) => set({ xrPosture }),
      }),
    ],
    sound: [volume('master', 'sound.master'), volume('music', 'sound.music'), volume('sfx', 'sound.sfx'), volume('ambient', 'sound.ambient')],
    display: [
      segmentedRow({
        setting: 'lang',
        label: 'display.lang',
        options: [
          { value: 'ja', label: 'lang.ja' },
          { value: 'en', label: 'lang.en' },
        ],
        get: (s) => s.lang,
        pick: (lang) => set({ lang }),
      }),
      segmentedRow({
        setting: 'textScale',
        label: 'display.textScale',
        options: [
          { value: 1, label: 'text.standard' },
          { value: 1.25, label: 'text.large' },
          { value: 1.5, label: 'text.xlarge' },
        ],
        get: (s) => s.textScale,
        pick: (textScale) => set({ textScale }),
      }),
    ],
  };

  // タブ（切り替えのたびに作り直さない。全部作って、選ばれたものだけ見せる）
  const ids = Object.fromEntries(TABS.map((tab) => [tab.id, nextId('tab')])) as Record<TabId, string>;
  const tabList = h('div', { class: 'tabs', role: 'tablist' });
  const tabButtons = TABS.map((tab) => h('button', { type: 'button', class: 'tab', role: 'tab', id: ids[tab.id], 'aria-controls': `${ids[tab.id]}-panel`, 'data-tab': tab.id, on: { click: () => selectTab(tab.id) } }));
  tabList.append(...tabButtons);
  arrowNav(tabList, '.tab');
  const panels = {} as Record<TabId, HTMLElement>;
  for (const tab of TABS) {
    panels[tab.id] = h('div', { class: 'tab-panel', role: 'tabpanel', id: `${ids[tab.id]}-panel`, 'aria-labelledby': ids[tab.id], hidden: tab.id !== 'quality' }, ...rows[tab.id].map((r) => r.el));
  }
  // 説明の文は該当の行のすぐ下に置く
  rows.look[1].el.after(gyroNote);
  rows.comfort[0].el.after(comfortNote.el);
  rows.sound[3].el.after(soundNote.el);

  let active: TabId = 'quality';
  function selectTab(id: TabId): void {
    active = id;
    TABS.forEach((tab, i) => {
      const on = tab.id === id;
      setAttr(tabButtons[i], 'aria-selected', String(on));
      setAttr(tabButtons[i], 'tabindex', on ? '0' : '-1');
      setHidden(panels[tab.id], !on);
    });
  }
  selectTab(active);

  const panel = h('div', { class: 'settings-panel glass-panel' }, tabList, ...TABS.map((tab) => panels[tab.id]));
  const el = h('section', { class: 'screen screen-settings', 'data-room': 'settings' }, header.el, panel);

  function syncRows(settings: Settings, tr: Tr): void {
    for (const list of Object.values(rows)) for (const row of list) row.sync(settings, tr);
    comfortNote.sync(tr('comfort.desc'));
    soundNote.sync(tr('sound.note'));
    setText(gyroNote, tr('look.gyro.denied'));
  }

  return {
    el,
    update(state) {
      latest = state.settings;
      isMobile = state.isMobile;
      header.update();
      TABS.forEach((tab, i) => setText(tabButtons[i], env.tr(tab.label)));
      syncRows(state.settings, env.tr);
      // 端末の傾きは、スマートフォンなど傾きを取れる端末にだけ出す
      setHidden(gyro.el, !isMobile);
      setHidden(gyroNote, !(isMobile && gyroDenied));
    },
    show() {
      selectTab('quality');
      header.focus();
    },
  };
}
