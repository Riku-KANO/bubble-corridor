// 画面（src/ui）の確認ページ。dev/ui.html から開く（本番ビルドには含まれない）。
// 各画面を仮の状態で切り替えて見る。後ろの景色は canvas で描いた仮の絵、写真も canvas で作った仮の画像。
//   ?screen=home   最初の画面（queue / home / guide / riding / pause / photo / shelf / settings / howto / credits）
//   ?lang=en       言語   ?xr=1  VR の項目を出す   ?mobile=1  スマートフォンの項目を出す
//   ?scale=1.25    文字の大きさ   ?comfort=gentle  快適モードを「穏やか」にする   ?rides=2  これまでの便の数   ?hidden=3  見つけた泡の数   ?develop=1  写真がまだ届いていない
//   ?fail=1        保存と共有を失敗させる
//   ?gyro=deny     「傾けて見回す」の許可を断られた場合にする（既定は許可される）
//   ?bar=0         切り替えのバーを出さない（撮影用）
import '@fontsource/zen-old-mincho/400.css';
import '@fontsource/noto-sans-jp/300.css';
import '@fontsource/noto-sans-jp/400.css';
import '../../styles/base.css';
import { HIDDEN_BUBBLE_SECTIONS, UI } from '../../config';
import type { RideRecord } from '../../contracts/events';
import type { SectionId, ShotId } from '../../contracts/ids';
import type { PhotoRecord } from '../../contracts/photo';
import type { ScreenId, Settings, UiCommands, UiState } from '../../contracts/ui';
import { defaultSettings, mountUi } from '../../ui';
import { drawBackdrop } from './backdrop';
import { makePhoto } from './photos';

const q = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const v = Number(q.get(key));
  return q.has(key) && Number.isFinite(v) ? v : fallback;
};
const SCREENS: readonly ScreenId[] = ['queue', 'home', 'guide', 'riding', 'pause', 'photo', 'shelf', 'settings', 'howto', 'credits'];
const first = q.get('screen');
const startScreen: ScreenId = SCREENS.find((s) => s === first) ?? 'home';
const lang = q.get('lang') === 'en' ? 'en' : 'ja';

const root = document.getElementById('app') as HTMLElement;
const backdrop = document.createElement('canvas');
backdrop.className = 'stage';
root.append(backdrop);

let settings: Settings = { ...defaultSettings(lang), comfort: q.get('comfort') === 'gentle' ? 'gentle' : 'standard', textScale: ([1, 1.25, 1.5] as const).find((x) => x === num('scale', 1)) ?? 1 };
const found = HIDDEN_BUBBLE_SECTIONS.slice(0, Math.max(0, Math.min(5, num('hidden', 2)))) as SectionId[];
let state: UiState = {
  screen: startScreen,
  loadProgress: startScreen === 'queue' ? num('load', 1) : 1,
  settings,
  progress: { rideCount: num('rides', 2), seenGuide: false, hiddenFound: found, lastDoor: null },
  xrSupported: q.get('xr') === '1',
  gyroNeedsPermission: true,
  isMobile: q.get('mobile') === '1',
  record: null,
  latestPhoto: null,
  shelf: [],
};

const record: RideRecord = { rideNo: state.progress.rideCount + 1, date: '2026-10-20', touches: 42, door: 'amber', constellations: 2, hiddenFound: found.slice(0, 1) };

async function buildPhoto(rideNo: number, chosen: ShotId, hiddenTotal: number): Promise<PhotoRecord> {
  const shots = await Promise.all((['bloom', 'freeze', 'constellation'] as const).map(async (shot) => ({ shot, image: await makePhoto(shot, 1280, 720) })));
  return {
    id: `ride-${rideNo}-${rideNo * 1000}`,
    createdAt: rideNo * 1000,
    meta: { rideNo, date: `2026-10-${String(10 + rideNo).padStart(2, '0')}`, door: rideNo % 2 ? 'amber' : 'lapis', hiddenTotal, constellations: 2, lang: settings.lang },
    shots,
    chosen,
  };
}

/** 呼ばれた命令の記録（確認の操作で「何が呼ばれたか」を見るため） */
const calls: string[] = [];
const ui = mountUi(root, makeCommands());
(window as unknown as { __devui: unknown }).__devui = {
  go,
  patch,
  ui,
  calls,
  get state() {
    return state;
  },
};

function makeCommands(): UiCommands {
  // ?fail=1 のとき、保存と共有を失敗させる（失敗の知らせを見るため）
  const failing = async (): Promise<void> => {
    if (q.get('fail') === '1') throw new Error('失敗（確認用）');
  };
  return {
    enterHome: () => go('home'),
    ride: () => {
      calls.push('ride');
      go(state.progress.seenGuide ? 'riding' : 'guide');
    },
    skipGuide: () => {
      calls.push('skipGuide');
      patch({ progress: { ...state.progress, seenGuide: true } });
      go('riding');
    },
    pause: () => go('pause'),
    resume: () => go('riding'),
    alight: () => go('home'),
    rideAgain: () => go('riding'),
    toHome: () => go('home'),
    open: (screen) => go(screen),
    back: () => go(returnTo),
    setSettings: (p) => {
      settings = { ...settings, ...p };
      document.documentElement.style.setProperty('--text-scale', String(settings.textScale));
      patch({ settings });
    },
    requestGyro: async () => {
      calls.push('requestGyro');
      return q.get('gyro') !== 'deny';
    },
    savePhoto: failing,
    sharePhoto: failing,
    choosePhoto: (r, shot) => {
      const next = { ...r, chosen: shot };
      patch({ latestPhoto: state.latestPhoto?.id === r.id ? next : state.latestPhoto, shelf: state.shelf.map((x) => (x.id === r.id ? next : x)) });
    },
    deletePhoto: async (id) => patch({ shelf: state.shelf.filter((x) => x.id !== id) }),
  };
}

let photos: PhotoRecord[] = [];
let returnTo: ScreenId = 'home';
let guideTimer = 0;
let loadTimer = 0;

function patch(p: Partial<UiState>): void {
  state = { ...state, ...p };
  ui.render(state);
}

function go(screen: ScreenId): void {
  const sub: readonly ScreenId[] = ['shelf', 'settings', 'howto', 'credits'];
  if (sub.includes(screen) && !sub.includes(state.screen)) returnTo = state.screen;
  window.clearTimeout(guideTimer);
  window.clearInterval(loadTimer);
  document.documentElement.style.setProperty('--text-scale', String(settings.textScale));
  document.documentElement.lang = settings.lang;
  drawBackdrop(backdrop, screen);
  let extra: Partial<UiState> = {};
  if (screen === 'photo') extra = { record, latestPhoto: q.get('develop') === '1' ? null : photos[0] ?? null };
  if (screen === 'shelf') extra = { shelf: photos.slice(0, 10) };
  if (screen === 'queue') extra = { loadProgress: num('load', 1) };
  patch({ screen, ...extra });
  if (screen === 'guide') guideTimer = window.setTimeout(() => go('riding'), UI.preRideGuideSec * 1000);
  if (screen === 'queue' && q.has('animate')) {
    let p = 0;
    patch({ loadProgress: 0 });
    loadTimer = window.setInterval(() => {
      p = Math.min(1, p + 0.125);
      patch({ loadProgress: p });
      if (p >= 1) window.clearInterval(loadTimer);
    }, 450);
  }
}

// 乗車中のふるまいを、app と同じ形で真似る（マウスの移動で雫、Esc でポーズ）
addEventListener('pointermove', () => {
  if (state.screen === 'riding') ui.flashPauseDrop();
});
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.screen === 'riding') go('pause');
  else if (state.screen === 'pause') go('riding');
});
addEventListener('resize', () => drawBackdrop(backdrop, state.screen));

// 確認用のバー
if (q.get('bar') !== '0') {
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;left:50%;bottom:6px;transform:translateX(-50%);z-index:100;display:flex;flex-wrap:wrap;gap:4px;justify-content:center;max-width:96vw;font:12px/1.2 sans-serif';
  const add = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:3px 7px;border:1px solid #fff5;border-radius:6px;background:#0008;color:#fff;cursor:pointer;font:inherit';
    b.addEventListener('click', fn);
    bar.append(b);
  };
  for (const s of SCREENS) add(s, () => go(s));
  add('hint', () => ui.showRideHint());
  add('lang', () => {
    settings = { ...settings, lang: settings.lang === 'ja' ? 'en' : 'ja' };
    patch({ settings });
  });
  document.body.append(bar);
}

void (async () => {
  photos = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => buildPhoto(n + state.progress.rideCount - 1, (['constellation', 'bloom', 'freeze'] as const)[n % 3], n === 1 ? found.length : Math.min(5, n))));
  go(startScreen);
})();
