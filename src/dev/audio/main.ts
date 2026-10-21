// 音の確認ページ（dev/audio.html）。本番ビルドには含まれない。
// 耳で確かめるための道具: 区間を選んで頭から再生、シーク、扉の切り替え、触れた音のパッド、出来事の効果音、
// 入口の音楽、音量。数字で確かめる道具: 音色ごと・曲全体の大きさ（measure.ts）。
import { MOMENT_BARS, SECTIONS, SEC_PER_BAR, RIDE_DURATION } from '../../config';
import type { RideEvents, Vec3Tuple } from '../../contracts/events';
import type { SfxId } from '../../contracts/audio';
import type { DoorChoice, TouchKind } from '../../contracts/ids';
import { SECTION_IDS } from '../../contracts/ids';
import { createAudioEngine } from '../../audio';
import { audioCues } from '../../audio/cues';
import type { AudioClock } from '../../audio/clock';
import { harmonyAt, sectionScore } from '../../audio/score';
import { SFX } from '../../audio/effects';
import { createBus } from '../../core/events';
import { createAuditioner } from './audition';
import { measureRide, measureTimbres, measureTouchTail } from './measure';
import type { LevelRow } from './measure';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} がない`);
  return el as T;
};
const button = (label: string, onClick: () => void, cls = ''): HTMLButtonElement => {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const QUALITY_LABEL: Record<string, string> = { maj: '', min: 'm', sus2: 'sus2', sus4: 'sus4', maj7: 'maj7', min7: 'm7', dom7: '7', add9: 'add9', min9: 'm9', dim: 'dim' };
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

const bus = createBus<RideEvents>();
const engine = createAudioEngine(bus);
// 本物のエンジンの時計は toContextTime / jumps を持つ（契約の型は RideClock）
const clock = engine.clock as AudioClock;
const auditioner = createAuditioner();
let door: DoorChoice = 'lapis';

// 見どころ・膜の効果音は、エンジンが先読みの中で乗車の秒から予約して鳴らす（cues.ts の一覧）。ここでは一覧を使うだけ
const cues = audioCues();
const barSec = (bar: number) => bar * SEC_PER_BAR;

// ── 画面 ──
const statusEl = $('status');
const nowEl = $('now');
const seek = $<HTMLInputElement>('seek');
const seekLabel = $('seekLabel');

function setStatus(): void {
  const lines = [`音: ${engine.unlocked ? '有効' : '未開始（「音を有効にする」を押す）'}`, `時計: ${clock.running ? '再生中' : 'ポーズ'}  ${mmss(clock.time)}`];
  statusEl.textContent = lines.join('\n');
}

function updateNow(): void {
  const t = clock.time;
  const h = harmonyAt(t, door);
  const s = sectionScore(h.section, door);
  const bar = Math.floor(t / SEC_PER_BAR + 1e-9);
  const rel = bar - s.startBar;
  const beat = Math.floor(((t / SEC_PER_BAR) % 1) * 4 + 1e-9) + 1;
  const chord = `${NOTE_NAMES[h.chord.root]}${QUALITY_LABEL[h.chord.quality]}`;
  const key = `${NOTE_NAMES[h.key.tonic]} ${h.key.mode === 'major' ? '長調' : '短調'}`;
  nowEl.textContent = [
    `${mmss(t)}  /  ${mmss(RIDE_DURATION)}`,
    `区間 ${h.section}${s.variant ? `（${s.variant}）` : ''}  残響 ${s.reverb}`,
    `小節 ${bar}（区間の ${rel}）拍 ${beat}`,
    `調 ${key}  和音 ${chord}`,
  ].join('\n');
  if (document.activeElement !== seek) seek.value = String(Math.round(t));
  seekLabel.textContent = mmss(Number(seek.value));
  setStatus();
}

function frame(): void {
  updateNow();
  requestAnimationFrame(frame);
}

async function enable(): Promise<void> {
  await engine.unlock();
  $('enabled').textContent = engine.unlocked ? '有効になりました' : '有効にできませんでした（もう一度押す）';
  engine.setDoor(door);
}

function playFrom(t: number): void {
  engine.setDoor(door);
  clock.start(t);
}

// ── 組み立て ──
$('enable').addEventListener('click', () => void enable());
$('play').addEventListener('click', () => {
  void enable().then(() => {
    if (clock.time >= RIDE_DURATION - 0.1) clock.start(0);
    else if (!clock.running && clock.time > 0) clock.resume();
    else if (!clock.running) playFrom(0);
  });
});
$('pause').addEventListener('click', () => {
  clock.pause();
  engine.sfx('pause');
});
$<HTMLSelectElement>('door').addEventListener('change', (e) => {
  door = (e.target as HTMLSelectElement).value as DoorChoice;
  engine.setDoor(door);
});
seek.addEventListener('input', () => {
  seekLabel.textContent = mmss(Number(seek.value));
});
seek.addEventListener('change', () => {
  engine.setDoor(door);
  clock.seek(Number(seek.value));
});

const sectionsEl = $('sections');
for (const id of SECTION_IDS) {
  const spec = SECTIONS.find((s) => s.id === id)!;
  sectionsEl.append(
    button(`${id} ${mmss(barSec(spec.startBar))}〜`, () => {
      void enable().then(() => playFrom(barSec(spec.startBar)));
    }),
  );
}
const highlights: [string, number][] = [
  ['花が開く（2:40）', MOMENT_BARS.greenhouseBloom],
  ['雨が止まる（5:10）', MOMENT_BARS.rainFreeze],
  ['扉（5:50）', MOMENT_BARS.rainDoors],
  ['万華鏡の花（7:20）', MOMENT_BARS.kaleidoscopeFlower],
  ['星座（9:50）', MOMENT_BARS.celestialConstellation],
  ['朝日（11:50）', MOMENT_BARS.dawnSunrise],
];
for (const [label, bar] of highlights) {
  sectionsEl.append(button(`${label} の4秒前から`, () => void enable().then(() => playFrom(barSec(bar) - 4)), 'primary'));
}

// 触れた音のパッド
const KINDS: TouchKind[] = ['hanging-bubble', 'leaf', 'bud', 'raindrop', 'door', 'shard', 'star', 'water', 'hidden-bubble'];
const padsEl = $('pads');
const touchLog = $('touchLog');
let touchCount = 0;
for (const kind of KINDS) {
  padsEl.append(
    button(kind, () => {
      const t = clock.time;
      const section = harmonyAt(t, door).section;
      const position: Vec3Tuple = [((touchCount++ % 5) - 2) * 1.5, 0.5, -3];
      const at = engine.touch({ id: `pad-${kind}`, kind, section, position });
      touchLog.textContent = `${kind}: ${at === null ? 'null（間引いた、または音が使えない／ポーズ中）' : `${at.toFixed(3)} 秒に鳴らす（今 ${t.toFixed(3)} 秒、差 ${((at - t) * 1000).toFixed(0)}ms）`}`;
    }),
  );
}

// 出来事の効果音（今の位置の和音で鳴らす）
const cuesEl = $('cues');
for (const c of cues) {
  cuesEl.append(
    button(c.id, () => {
      auditioner.play({ ...c, t: clock.running ? clock.time : c.t }, door);
    }),
  );
}
$('lure').addEventListener('click', () => void enable().then(() => engine.lure([-4, 0, -6])));

const sfxEl = $('sfx');
for (const id of Object.keys(SFX) as SfxId[]) sfxEl.append(button(id, () => void enable().then(() => engine.sfx(id))));

$('lobbyOn').addEventListener('click', () => void enable().then(() => engine.playLobby()));
$('lobbyOff').addEventListener('click', () => engine.stopLobby());

const volsEl = $('vols');
const vols = { master: 0.85, music: 0.85, sfx: 0.9, ambient: 0.8 };
for (const key of ['master', 'music', 'sfx', 'ambient'] as const) {
  const label = document.createElement('label');
  label.className = 'vol';
  label.append(document.createTextNode(`${key} `));
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = '1';
  input.step = '0.01';
  input.value = String(vols[key]);
  input.addEventListener('input', () => {
    vols[key] = Number(input.value);
    engine.setVolumes({ ...vols });
    auditioner.setVolumes({ ...vols });
  });
  label.append(input);
  volsEl.append(label);
}

// 測定
function showRows(rows: readonly LevelRow[]): void {
  const out = $('measureOut');
  out.textContent = '';
  const table = document.createElement('table');
  const head = table.insertRow();
  for (const h of ['', 'RMS (dBFS)', 'ピーク']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.append(th);
  }
  for (const r of rows) {
    const tr = table.insertRow();
    tr.insertCell().textContent = r.label;
    tr.insertCell().textContent = r.rmsDb.toFixed(1);
    const peak = tr.insertCell();
    peak.textContent = r.peak.toFixed(3);
    if (r.peak >= 0.99) peak.style.color = '#ff8a8a';
  }
  out.append(table);
}
let lastRows: LevelRow[] = [];
$('measureTimbres').addEventListener('click', () => {
  $('measureState').textContent = '測定中…';
  void measureTimbres().then((rows) => {
    lastRows = rows;
    showRows(rows);
    $('measureState').textContent = '完了';
  });
});
$('measureRide').addEventListener('click', () => {
  $('measureState').textContent = '描画中…';
  void measureRide(door, (done, total) => {
    $('measureState').textContent = `描画中 ${done}/${total}`;
  }).then((rows) => {
    lastRows = rows;
    showRows(rows);
    $('measureState').textContent = '完了';
  });
});

// Playwright など自動の確認から触れるように
Object.assign(window, {
  __audioDev: {
    engine,
    bus,
    cues,
    setDoor: (d: DoorChoice) => {
      door = d;
      engine.setDoor(d);
    },
    measureTimbres,
    measureRide,
    measureTouchTail,
    get lastRows() {
      return lastRows;
    },
  },
});

frame();
