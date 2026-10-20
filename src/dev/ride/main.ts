// ride 確認ページ（dev/ride.html）。レールの地図・速度と高さのグラフ・時刻のスライダー。本番のビルドには含まれない。
//   ?t=秒 で開く時刻。レールは1本（ADR-0008）なので標準も穏やかも同じ道筋で、穏やかの上限（上下 0.3 m/s、回転 7.5°/s）以内に設計してある。
import { MOMENT_BARS, MOTION, RIDE_DURATION, SEC_PER_BAR, SECTIONS } from '../../config';
import type { SectionId } from '../../contracts/ids';
import type { RidePose } from '../../contracts/ride';
import { analyzeComfort, comfortPeaks, createRide, describeDesign, generateRideData } from '../../ride';

const COLORS: Record<SectionId, string> = {
  platform: '#7db4e6',
  greenhouse: '#62c98c',
  rain: '#6f8fc0',
  kaleidoscope: '#e0b34e',
  celestial: '#9d82f0',
  dawn: '#f09ab5',
  departure: '#b5d4f2',
};
const LABEL: Record<SectionId, string> = {
  platform: '乗り場',
  greenhouse: '温室',
  rain: '雨の回廊',
  kaleidoscope: '万華鏡',
  celestial: '天球',
  dawn: '夜明けの岸',
  departure: '降車',
};
const HIGHLIGHTS: readonly { label: string; bar: number }[] = [
  { label: '花', bar: MOMENT_BARS.greenhouseBloom },
  { label: '雨が止まる', bar: MOMENT_BARS.rainFreeze },
  { label: '扉', bar: MOMENT_BARS.rainDoors },
  { label: '花の模様', bar: MOMENT_BARS.kaleidoscopeFlower },
  { label: '星座', bar: MOMENT_BARS.celestialConstellation },
  { label: '朝日', bar: MOMENT_BARS.dawnSunrise },
];

const data = generateRideData();
const ride = createRide(data);
const design = describeDesign();
const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 };

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} がない`);
  return el as T;
};
const ctx2d = (id: string): CanvasRenderingContext2D => {
  const c = $<HTMLCanvasElement>(id).getContext('2d');
  if (!c) throw new Error('canvas 2d が使えない');
  return c;
};
const fmtTime = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
/** 秒まで（見どころの名札用）。小数の端で 59.99 → 60 にならないよう先に丸める */
const fmtSec = (t: number) => {
  const sec = Math.round(t);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
const deg = (rad: number) => (rad * 180) / Math.PI;

const params = new URLSearchParams(location.search);
let t = Math.min(RIDE_DURATION, Math.max(0, Number(params.get('t')) || 0));
let playing = false;

// ── 地図 ──
const mapCtx = ctx2d('map');
const MAP = { w: 640, h: 640, pad: 44 };
const pts = data.rail.points;
// 地図の範囲: レールと、目安の円（ホール、天球の入口までの半径）が入るように
const bounds = pts.reduce(
  (b, p) => ({ x0: Math.min(b.x0, p[0]), x1: Math.max(b.x1, p[0]), z0: Math.min(b.z0, p[2]), z1: Math.max(b.z1, p[2]) }),
  { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity },
);
for (const c of [
  { x: design.hall.x, z: design.hall.z, r: design.hall.radius },
  { x: design.celestial.center.x, z: design.celestial.center.z, r: design.celestial.entryRadius },
]) {
  bounds.x0 = Math.min(bounds.x0, c.x - c.r);
  bounds.x1 = Math.max(bounds.x1, c.x + c.r);
  bounds.z0 = Math.min(bounds.z0, c.z - c.r);
  bounds.z1 = Math.max(bounds.z1, c.z + c.r);
}
const scale = Math.min((MAP.w - MAP.pad * 2) / (bounds.x1 - bounds.x0), (MAP.h - MAP.pad * 2) / (bounds.z1 - bounds.z0));
const mx = (x: number) => MAP.pad + (x - bounds.x0) * scale;
const my = (z: number) => MAP.pad + (z - bounds.z0) * scale;

function drawMap(): void {
  const c = mapCtx;
  c.clearRect(0, 0, MAP.w, MAP.h);
  c.fillStyle = '#0e131c';
  c.fillRect(0, 0, MAP.w, MAP.h);
  // 50m の格子
  c.strokeStyle = '#1b2434';
  c.lineWidth = 1;
  c.font = '10px sans-serif';
  c.fillStyle = '#4b586d';
  for (let x = Math.ceil(bounds.x0 / 50) * 50; x <= bounds.x1; x += 50) {
    c.beginPath();
    c.moveTo(mx(x), MAP.pad / 2);
    c.lineTo(mx(x), MAP.h - MAP.pad / 2);
    c.stroke();
    c.fillText(`${x}`, mx(x) + 2, MAP.h - 8);
  }
  for (let z = Math.ceil(bounds.z0 / 50) * 50; z <= bounds.z1; z += 50) {
    c.beginPath();
    c.moveTo(MAP.pad / 2, my(z));
    c.lineTo(MAP.w - MAP.pad / 2, my(z));
    c.stroke();
    c.fillText(`${z}`, 4, my(z) - 2);
  }
  // 部屋の目安の円: 乗り場のホール、天球（中心から出口の膜までの半径と、入口の膜までの半径）
  const circle = (x: number, z: number, r: number, color: string, dash: number[], label: string) => {
    c.strokeStyle = color;
    c.lineWidth = 1.5;
    c.setLineDash(dash);
    c.beginPath();
    c.arc(mx(x), my(z), r * scale, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = color;
    c.font = '10px sans-serif';
    c.fillText(label, mx(x) - 14, my(z) - r * scale - 4);
  };
  circle(design.hall.x, design.hall.z, design.hall.radius, '#7db4e655', [], 'ホール');
  circle(design.celestial.center.x, design.celestial.center.z, design.celestial.exitRadius, '#9d82f055', [], '天球（出口まで）');
  circle(design.celestial.center.x, design.celestial.center.z, design.celestial.entryRadius, '#9d82f044', [4, 4], '入口まで');
  // 区間ごとの色
  c.lineWidth = 5;
  c.lineCap = 'round';
  for (const sec of data.sections) {
    c.strokeStyle = COLORS[sec.id];
    c.beginPath();
    let first = true;
    for (let s = sec.s0; s <= sec.s1 + 0.5; s += 1) {
      const p = ride.pointAt(Math.min(s, sec.s1));
      if (first) c.moveTo(mx(p.x), my(p.z));
      else c.lineTo(mx(p.x), my(p.z));
      first = false;
    }
    c.stroke();
  }
  // 膜（区間の境目）と区間の名前
  c.font = '12px sans-serif';
  for (const sec of data.sections) {
    const a = ride.pointAt(sec.s0);
    if (sec.id !== 'platform') {
      const nx = Math.cos(a.yaw);
      const nz = -Math.sin(a.yaw);
      c.strokeStyle = '#ffffff';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(mx(a.x - nx * 9), my(a.z - nz * 9));
      c.lineTo(mx(a.x + nx * 9), my(a.z + nz * 9));
      c.stroke();
    }
    const m = ride.pointAt((sec.s0 + sec.s1) / 2);
    c.fillStyle = COLORS[sec.id];
    // 輪の外側へ名前を出す（地図の中心から遠ざかる向き）
    const cx = (bounds.x0 + bounds.x1) / 2;
    const cz = (bounds.z0 + bounds.z1) / 2;
    const dx = m.x - cx;
    const dz = m.z - cz;
    const d = Math.hypot(dx, dz) || 1;
    const label = LABEL[sec.id];
    const w = c.measureText(label).width;
    const lx = mx(m.x + (dx / d) * 14);
    c.fillText(label, Math.min(MAP.w - w - 4, Math.max(4, dx > 0 ? lx : lx - w)), my(m.z + (dz / d) * 14) + 4);
  }
  c.textAlign = 'left';
  // 見どころ
  for (const h of HIGHLIGHTS) {
    const tt = h.bar * SEC_PER_BAR;
    ride.poseAt(tt, 'standard', pose);
    const p = ride.pointAt(pose.s);
    const px = mx(p.x);
    const py = my(p.z);
    c.fillStyle = '#ffd479';
    c.beginPath();
    c.moveTo(px, py - 6);
    c.lineTo(px + 6, py);
    c.lineTo(px, py + 6);
    c.lineTo(px - 6, py);
    c.closePath();
    c.fill();
    c.fillStyle = '#ffe9b8';
    c.font = '11px sans-serif';
    c.fillText(`${fmtSec(tt)} ${h.label}`, px + 9, py - 6);
  }
  // 始点
  c.fillStyle = '#ffffff';
  c.beginPath();
  c.arc(mx(pts[0][0]), my(pts[0][2]), 4, 0, Math.PI * 2);
  c.fill();
  c.font = '11px sans-serif';
  c.fillText('乗り場の始点', mx(pts[0][0]) + 8, my(pts[0][2]) + 14);
  // 比較の物差し: 30m
  c.strokeStyle = '#8b97ab';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(MAP.pad, MAP.pad - 14);
  c.lineTo(MAP.pad + 30 * scale, MAP.pad - 14);
  c.stroke();
  c.fillStyle = '#8b97ab';
  c.fillText('30m', MAP.pad + 30 * scale + 6, MAP.pad - 10);

  // いまの位置と向き
  ride.poseAt(t, 'standard', pose);
  const px = mx(pose.x);
  const py = my(pose.z);
  c.strokeStyle = '#ffffff';
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(px, py);
  c.lineTo(px + -Math.sin(pose.yaw) * 22, py + -Math.cos(pose.yaw) * 22);
  c.stroke();
  c.fillStyle = '#ffffff';
  c.beginPath();
  c.arc(px, py, 6, 0, Math.PI * 2);
  c.fill();
}

// ── グラフ ──
interface Series {
  t: Float64Array;
  speed: Float64Array;
  y: Float64Array;
}
const series: Series = (() => {
  const n = Math.round(RIDE_DURATION / 0.25) + 1;
  const s: Series = { t: new Float64Array(n), speed: new Float64Array(n), y: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    const tt = i * 0.25;
    s.t[i] = tt;
    ride.poseAt(tt, 'standard', pose);
    s.speed[i] = pose.speed;
    s.y[i] = pose.y;
  }
  return s;
})();

interface ChartBox {
  c: CanvasRenderingContext2D;
  w: number;
  h: number;
  l: number;
  r: number;
  top: number;
  bottom: number;
}
function chartBox(id: string): ChartBox {
  const el = $<HTMLCanvasElement>(id);
  return { c: ctx2d(id), w: el.width, h: el.height, l: 38, r: 10, top: 10, bottom: 22 };
}
const speedBox = chartBox('speed');
const heightBox = chartBox('height');
const tx = (b: ChartBox, tt: number) => b.l + (tt / RIDE_DURATION) * (b.w - b.l - b.r);

function drawChartFrame(b: ChartBox, y0: number, y1: number, ticks: number[]): (v: number) => number {
  const { c } = b;
  c.clearRect(0, 0, b.w, b.h);
  c.fillStyle = '#0e131c';
  c.fillRect(0, 0, b.w, b.h);
  const yy = (v: number) => b.top + (1 - (v - y0) / (y1 - y0)) * (b.h - b.top - b.bottom);
  // 区間の帯
  for (const sec of SECTIONS) {
    const t0 = sec.startBar * SEC_PER_BAR;
    const t1 = (sec.startBar + sec.bars) * SEC_PER_BAR;
    c.fillStyle = `${COLORS[sec.id]}22`;
    c.fillRect(tx(b, t0), b.top, tx(b, t1) - tx(b, t0), b.h - b.top - b.bottom);
    c.fillStyle = '#6a778c';
    c.font = '10px sans-serif';
    c.textAlign = 'left';
    c.fillText(`${Math.floor(t0 / 60)}:${String(Math.round(t0 % 60)).padStart(2, '0')}`, tx(b, t0) + 2, b.h - 8);
  }
  c.strokeStyle = '#2a3345';
  c.lineWidth = 1;
  c.fillStyle = '#8b97ab';
  c.textAlign = 'right';
  for (const v of ticks) {
    c.beginPath();
    c.moveTo(b.l, yy(v));
    c.lineTo(b.w - b.r, yy(v));
    c.stroke();
    c.fillText(`${v}`, b.l - 4, yy(v) + 3);
  }
  // 見どころの時刻
  c.strokeStyle = '#ffd47988';
  c.setLineDash([2, 3]);
  for (const h of HIGHLIGHTS) {
    c.beginPath();
    c.moveTo(tx(b, h.bar * SEC_PER_BAR), b.top);
    c.lineTo(tx(b, h.bar * SEC_PER_BAR), b.h - b.bottom);
    c.stroke();
  }
  c.setLineDash([]);
  c.textAlign = 'left';
  return yy;
}

function drawCursor(b: ChartBox): void {
  b.c.strokeStyle = '#ffffff';
  b.c.lineWidth = 1.5;
  b.c.beginPath();
  b.c.moveTo(tx(b, t), b.top);
  b.c.lineTo(tx(b, t), b.h - b.bottom);
  b.c.stroke();
}

function drawSpeed(): void {
  const b = speedBox;
  const yy = drawChartFrame(b, 0, 1.6, [0, 0.5, 1, 1.5]);
  const guide = (v: number, color: string) => {
    b.c.strokeStyle = color;
    b.c.setLineDash([4, 4]);
    b.c.beginPath();
    b.c.moveTo(b.l, yy(v));
    b.c.lineTo(b.w - b.r, yy(v));
    b.c.stroke();
    b.c.setLineDash([]);
  };
  guide(MOTION.highlightSpeed, '#ffd479'); // 見どころ
  guide(MOTION.driftMax, '#7fe0a8'); // 普段の速さの上限
  guide(MOTION.afterHighlightMax, '#7fe0a855'); // 見どころの後の上限
  b.c.strokeStyle = '#ffffff';
  b.c.lineWidth = 2;
  b.c.beginPath();
  for (let i = 0; i < series.t.length; i++) {
    const x = tx(b, series.t[i]);
    if (i === 0) b.c.moveTo(x, yy(series.speed[i]));
    else b.c.lineTo(x, yy(series.speed[i]));
  }
  b.c.stroke();
  drawCursor(b);
}

function drawHeight(): void {
  const b = heightBox;
  const lo = Math.floor(Math.min(...series.y));
  const hi = Math.ceil(Math.max(...series.y));
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += 2) ticks.push(v);
  const yy = drawChartFrame(b, lo, hi, ticks);
  b.c.strokeStyle = '#ffffff';
  b.c.lineWidth = 2;
  b.c.beginPath();
  for (let i = 0; i < series.t.length; i++) {
    const x = tx(b, series.t[i]);
    if (i === 0) b.c.moveTo(x, yy(series.y[i]));
    else b.c.lineTo(x, yy(series.y[i]));
  }
  b.c.stroke();
  drawCursor(b);
}

// ── 表 ──
function setRows(table: HTMLElement, rows: readonly (readonly (string | { text: string; cls: string })[])[], header?: readonly string[]): void {
  table.textContent = '';
  const add = (cells: readonly (string | { text: string; cls: string })[], th: boolean) => {
    const tr = document.createElement('tr');
    for (const cell of cells) {
      const td = document.createElement(th ? 'th' : 'td');
      const text = typeof cell === 'string' ? cell : cell.text;
      td.textContent = text;
      td.className = typeof cell === 'string' ? 'num' : `num ${cell.cls}`;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  };
  if (header) add(header, true);
  for (const r of rows) add(r, false);
}

function updateNow(): void {
  ride.poseAt(t, 'standard', pose);
  const ok = pose.speed <= MOTION.speedMax;
  setRows($('now'), [
    ['時刻', fmtTime(t)],
    ['区間', `${LABEL[pose.section]}（進み具合 ${(pose.sectionProgress * 100).toFixed(0)}%）`],
    ['速さ', { text: `${pose.speed.toFixed(2)} m/s`, cls: ok ? 'ok' : 'ng' }],
    ['距離 s', `${pose.s.toFixed(1)} m`],
    ['位置', `x ${pose.x.toFixed(1)}  y ${pose.y.toFixed(2)}  z ${pose.z.toFixed(1)}`],
    ['向き', `${deg(pose.yaw).toFixed(1)}°`],
  ]);
  $('timeLabel').textContent = fmtTime(t);
  ($('time') as HTMLInputElement).value = String(t);
}

function fillStatic(): void {
  const rows: (string | { text: string; cls: string })[][] = [];
  for (const mdl of ['standard', 'gentle'] as const) {
    const v = analyzeComfort(data, mdl);
    const p = comfortPeaks(data, mdl);
    const k = mdl === 'gentle' ? MOTION.gentleFactor : 1;
    rows.push([
      mdl === 'standard' ? '標準' : '穏やか',
      { text: `違反 ${v.length} 件`, cls: v.length === 0 ? 'ok' : 'ng' },
      `速度 ${p.speed.toFixed(2)}/${MOTION.speedMax}`,
      `加速度 ${p.accel.toFixed(2)}/${MOTION.accelMax}`,
      `上下 ${p.vertical.toFixed(2)}/${(MOTION.verticalMax * k).toFixed(2)}`,
      `回転 ${p.yawRate.toFixed(1)}/${(MOTION.yawRateMaxDeg * k).toFixed(1)}°/s`,
    ]);
  }
  setRows($('comfort'), rows);
  const legRows = design.legs.map((l) => {
    const len = l.s1 - l.s0;
    return [
      { text: l.name, cls: '' },
      `${fmtSec(l.t0)}–${fmtSec(l.t1)}`,
      `${len.toFixed(0)} m`,
      `平均 ${(len / (l.t1 - l.t0)).toFixed(2)}`,
      `最大 ${l.maxSpeed.toFixed(2)}`,
      `高さ ${l.yMin.toFixed(1)}〜${l.yMax.toFixed(1)} m`,
    ];
  });
  setRows($('legs'), legRows);
  // 目印（部屋の担当が物を置く基準）
  const lm = (name: string, p: { t: number; s: number; x: number; y: number; z: number; yaw: number }) => [
    { text: name, cls: '' },
    fmtSec(p.t),
    `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`,
    `yaw ${deg(p.yaw).toFixed(0)}°`,
  ];
  setRows($('landmarks'), [
    lm('乗り場の始点', design.dock),
    ...design.membranes.map((m) => lm(`膜 → ${LABEL[m.to]}`, m)),
    ...Object.entries(design.highlights).map(([name, p]) => lm(name, p)),
    [{ text: '天球の中心', cls: '' }, '9:50', `(${design.celestial.center.x.toFixed(1)}, ${design.celestial.center.y.toFixed(1)}, ${design.celestial.center.z.toFixed(1)})`, `入口まで ${design.celestial.entryRadius.toFixed(0)} m / 出口まで ${design.celestial.exitRadius.toFixed(0)} m`],
    [{ text: 'ホール', cls: '' }, '', `中心 (${design.hall.x.toFixed(1)}, ${design.hall.z.toFixed(1)})`, `半径 ${design.hall.radius.toFixed(1)} m`],
  ]);
  setRows($('floors'), [[{ text: '床・水面の高さ', cls: '' }, `乗り場の水面 ${design.floors.platformWater}`, `温室の床 ${design.floors.greenhouseFloor}`, `回廊の床 ${design.floors.rainFloor}`, `岸の水面 ${design.floors.dawnWater}`]]);
}

function redraw(): void {
  drawMap();
  drawSpeed();
  drawHeight();
  updateNow();
}

// ── 操作 ──
const slider = $<HTMLInputElement>('time');
slider.addEventListener('input', () => {
  t = Number(slider.value);
  redraw();
});
const rateSel = $<HTMLSelectElement>('rate');
const playBtn = $<HTMLButtonElement>('play');
let last = 0;
function tick(now: number): void {
  if (!playing) return;
  t = Math.min(RIDE_DURATION, t + ((now - last) / 1000) * Number(rateSel.value));
  last = now;
  if (t >= RIDE_DURATION) {
    playing = false;
    playBtn.textContent = '再生';
  }
  redraw();
  requestAnimationFrame(tick);
}
playBtn.addEventListener('click', () => {
  playing = !playing;
  playBtn.textContent = playing ? '停止' : '再生';
  if (playing) {
    if (t >= RIDE_DURATION) t = 0;
    last = performance.now();
    requestAnimationFrame(tick);
  }
});

fillStatic();
redraw();
