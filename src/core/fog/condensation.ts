// 曇りと指の文字の効果。案1と共有する。
// ポーズ（泡の内側に息を吹きかけたような曇り）、乗車前の案内（曇りガラスの立て札に指で書く）、
// 乗車中の案内（泡の内側の曇りに書く）に使う。canvas に描くので、DOM にも 3D のテクスチャにも使える。
//
// 仕組み: 曇り（ノイズの霞＋細かい水滴）は大きさが決まるたびに一度だけ作って取っておく。
// 毎フレームは、その曇りを密度に応じた広がりで重ね、指でなぞった文字の形を「拭き取り」として抜くだけ。
// 時間はすべて now（秒）から計算し、フレームの積み上げで状態を作らない（tick を呼ばなければ進まない）。
// 2D の描画が使えない環境（jsdom。document のない node も）では何も描かず、時間と約束（Promise）だけ進める。
import { easeInOutSine, smoothstep } from '../easing';

export interface WriteOptions {
  /** 全行を書き終えるまでの秒 */
  readonly durationSec?: number;
  /**
   * CSS の font（例: "300 28px 'Zen Old Mincho'"）。
   * `var(--font-serif)` のような CSS 変数も書ける（canvas は変数を解決しないので、ここで解決する）。
   * 既定は Zen Old Mincho の細め（400）。大きさは画面に収まるよう自動で決め、指定した大きさより大きくはしない。
   */
  readonly font?: string;
  readonly align?: 'center' | 'left';
  /** 行の間隔（文字の高さに対する倍率） */
  readonly lineHeight?: number;
  /** 幅に収めるために自動で縮めるときの最小の文字の大きさ（px）。既定 18（設計書の最小の文字サイズ）。収まらなければ縁で切れる */
  readonly minFontPx?: number;
}

export interface Condensation {
  /** 描画先。DOM に置くか、CanvasTexture の元にする */
  readonly canvas: HTMLCanvasElement;
  /** 曇りの濃さ（0〜1） */
  readonly density: number;
  /** 曇らせる（中心から広がる） */
  fogIn(durationSec: number): Promise<void>;
  /** 晴らす */
  clear(durationSec: number): Promise<void>;
  /** 指でなぞった文字を書く。書き終わると resolve。曇りがある所にだけ見える（拭き取りなので） */
  write(lines: readonly string[], opts?: WriteOptions): Promise<void>;
  /** 書いた文字を曇りに溶かして消す */
  erase(durationSec: number): Promise<void>;
  /** 毎フレーム（requestAnimationFrame の外から動かすとき）。now は秒 */
  tick(now: number): void;
  resize(width: number, height: number, dpr: number): void;
  dispose(): void;
}

export interface CondensationOptions {
  readonly width: number;
  readonly height: number;
  readonly dpr?: number;
  /** 曇りの色（CSS の色） */
  readonly tint?: string;
  /** 時刻の出どころ（テストで差し替える）。既定は performance.now()/1000 */
  readonly now?: () => number;
  /** 自分で requestAnimationFrame を回すか（既定 true。3D のテクスチャにするときは false で tick を呼ぶ） */
  readonly autoTick?: boolean;
  /** 描き直すたびに呼ぶ。CanvasTexture にするとき `texture.needsUpdate = true` を入れる */
  readonly onDraw?: () => void;
}

// ───────────────────────────── 小さな道具 ─────────────────────────────

const clamp01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t);

/** 整数の格子から 0〜1 の値（乱数の種を変えても同じ並びになるよう、状態を持たない） */
function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < 4; i++) {
    sum += amp * valueNoise(x * f, y * f, seed + i * 17);
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / 0.9375; // 0.5+0.25+0.125+0.0625
}

/** 同じ並びの乱数（曇りの水滴は、大きさを変えても同じ配置にしたい） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * document のない環境（node。案1の vitest は jsdom を持たず、共通部品のテストは node で走る）で使う、中身のない canvas の代わり。
 * 大きさ（width・height）と style だけを持ち、getContext は null を返すので、何も描かず時間と約束だけ進む。
 */
function stubCanvas(): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    style: {},
    isConnected: false,
    getContext: () => null,
  } as unknown as HTMLCanvasElement;
}

const makeCanvas = (w: number, h: number): HTMLCanvasElement => {
  const c = typeof document === 'undefined' ? stubCanvas() : document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};

/** jsdom は getContext が未実装で、呼ぶたびに「Not implemented」を標準エラーへ出す。出さずに null と同じ扱いにする */
const noCanvas = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);

/** 2D の描画面を取る。取れない環境（jsdom）では null */
function context2d(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
  if (noCanvas) return null;
  try {
    return c.getContext('2d');
  } catch {
    return null;
  }
}

// ───────────────────────────── 曇りの質感 ─────────────────────────────

/** 水滴の 1 粒（つるんとしたレンズ: 下側に影、左上に小さな光）。大きさを変えて何度も貼る */
function makeDropSprite(): HTMLCanvasElement | null {
  const size = 64;
  const c = makeCanvas(size, size);
  const g = context2d(c);
  if (!g) return null;
  const r = size * 0.42;
  const cx = size / 2;
  const cy = size / 2;
  // 本体: 縁に向かって少し明るい（水滴は縁で光を集める）
  const body = g.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
  body.addColorStop(0, 'rgba(255,255,255,0.05)');
  body.addColorStop(0.75, 'rgba(255,255,255,0.14)');
  body.addColorStop(1, 'rgba(255,255,255,0.34)');
  g.fillStyle = body;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  // 下側の影（光を集めた反対側が少し暗い）
  const shade = g.createRadialGradient(
    cx + r * 0.25,
    cy + r * 0.35,
    r * 0.35,
    cx + r * 0.25,
    cy + r * 0.35,
    r * 1.05,
  );
  shade.addColorStop(0, 'rgba(40,70,110,0)');
  shade.addColorStop(1, 'rgba(40,70,110,0.28)');
  g.save();
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = shade;
  g.fillRect(0, 0, size, size);
  g.restore();
  // 左上の小さな光
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.beginPath();
  g.ellipse(cx - r * 0.38, cy - r * 0.42, r * 0.2, r * 0.13, -0.6, 0, Math.PI * 2);
  g.fill();
  return c;
}

/** 霞と水滴の細かさの上限（dpr）。これ以上は画素を増やしても曇りの見た目は変わらず、作る時間とメモリだけ増える（描くとき引き伸ばす） */
const FOG_DPR_MAX = 1.5;

/** 中心から広がる曇りの縁の形（中心から内側の 62% は 1、外へ向かって 0 まで）。一度作って、大きさを変えて貼る */
function makeRadialSprite(): HTMLCanvasElement | null {
  const size = 256;
  const c = makeCanvas(size, size);
  const g = context2d(c);
  if (!g) return null;
  const grad = g.createRadialGradient(size / 2, size / 2, size * 0.5 * 0.62, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/** 書き進みの先端のぼかし（左が 1、右が 0 の横の帯）。一度作って、行ごとに伸ばして貼る */
function makeRampSprite(): HTMLCanvasElement | null {
  const c = makeCanvas(64, 4);
  const g = context2d(c);
  if (!g) return null;
  const grad = g.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 4);
  return c;
}

/**
 * 曇りの下地を作る（大きさが変わるたびに一度だけ）。
 * 1. ノイズの霞: 小さな画像で作って引き伸ばす（滑らかで速い）。縁がやや濃い（息は中心から薄れる）
 * 2. 細かい水滴: 数千粒。小さいものは円、大きいものは水滴の絵を貼る
 */
function buildFogTexture(w: number, h: number, dpr: number, tint: string): HTMLCanvasElement | null {
  const out = makeCanvas(w, h);
  const g = context2d(out);
  if (!g) return null;

  // 1. 霞
  const cw = Math.max(8, Math.ceil(w / 6));
  const ch = Math.max(8, Math.ceil(h / 6));
  const haze = makeCanvas(cw, ch);
  const hg = context2d(haze);
  if (!hg) return null;
  const img = hg.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const u = x / cw;
      const v = y / ch;
      // 縦横同じ細かさのむらにする（画面が横長でも、横縞にならないように高さを基準にする）
      const n = fbm((x / ch) * 3.4, (y / ch) * 3.4, 3);
      const fine = valueNoise((x / ch) * 22, (y / ch) * 22, 9); // 細かいざらつき
      const dx = u - 0.5;
      const dy = v - 0.5;
      const edge = Math.min(1, (dx * dx + dy * dy) * 2.4); // 縁ほど少し濃い
      const a = 0.26 + 0.34 * n + 0.07 * (fine - 0.5) + 0.12 * edge;
      img.data[(y * cw + x) * 4 + 3] = Math.round(255 * Math.min(0.92, Math.max(0, a)));
    }
  }
  hg.putImageData(img, 0, 0);
  // 色は後から付ける（CSS の色をそのまま使うため、アルファだけのノイズに source-in で塗る）
  hg.globalCompositeOperation = 'source-in';
  hg.fillStyle = tint;
  hg.fillRect(0, 0, cw, ch);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(haze, 0, 0, w, h);

  // 2. 水滴
  const rnd = mulberry32(20261021);
  const areaCss = (w / dpr) * (h / dpr);
  const sprite = makeDropSprite();
  const count = Math.round(Math.min(7000, Math.max(250, areaCss / 55)));
  for (let i = 0; i < count; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    // 小さい粒がほとんど。たまに大きい粒
    const big = rnd();
    const rCss = big > 0.985 ? 3.6 + rnd() * 3.2 : big > 0.9 ? 1.6 + rnd() * 1.6 : 0.45 + rnd() * 0.9;
    const r = rCss * dpr;
    if (sprite && rCss > 1.3) {
      g.globalAlpha = 0.55 + rnd() * 0.45;
      g.drawImage(sprite, x - r * 1.19, y - r * 1.19, r * 2.38, r * 2.38);
    } else {
      g.globalAlpha = 0.12 + rnd() * 0.22;
      g.fillStyle = 'rgba(255,255,255,1)';
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.globalAlpha = 1;
  return out;
}

// ───────────────────────────── 文字の配置 ─────────────────────────────

interface Layout {
  readonly sizePx: number;
  /** 1 行の高さ（文字の大きさ × 行間） */
  readonly lineH: number;
  readonly fontSpec: string;
  readonly lines: readonly { text: string; x: number; y: number; width: number }[];
  /** 各行が書かれる区間（0〜1 の進みの中で、行ごとに文字数に比例） */
  readonly spans: readonly [number, number][];
}

const DEFAULT_FAMILY = "'Zen Old Mincho', 'Hiragino Mincho ProN', serif";

/** font 文字列の `var(--name, fallback)` を、いまの CSS の値に置き換える（canvas の font は変数を解決しない） */
function resolveCssVars(font: string, host: Element | null): string {
  if (!font.includes('var(')) return font;
  const style = host && typeof getComputedStyle === 'function' ? getComputedStyle(host) : null;
  return font.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_m, name: string, fallback?: string) => {
    const v = style?.getPropertyValue(name).trim();
    return v ? v : (fallback?.trim() ?? DEFAULT_FAMILY);
  });
}

/** CSS の font から px の大きさだけ取り出す（なければ null） */
const sizeOf = (font: string): number | null => {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : null;
};

// ───────────────────────────── 本体 ─────────────────────────────

interface Ramp {
  readonly from: number;
  readonly to: number;
  readonly start: number;
  readonly dur: number;
  readonly done: () => void;
}

interface TextState {
  readonly lines: readonly string[];
  readonly opts: WriteOptions;
  layout: Layout | null;
  start: number;
  dur: number;
  /** 書き進み（0〜1） */
  progress: number;
  /** 拭き取りの残り（1 = 文字が澄んでいる、0 = 曇りに溶けた） */
  amount: number;
  written: (() => void) | null;
  erasing: { start: number; dur: number; from: number; done: () => void } | null;
}

export function createCondensation(opts: CondensationOptions): Condensation {
  const now = opts.now ?? (() => performance.now() / 1000);
  const autoTick = opts.autoTick ?? true;
  const tint = opts.tint ?? '#e4eef8';

  let cssW = opts.width;
  let cssH = opts.height;
  let dpr = opts.dpr ?? 1;
  const px = (v: number) => Math.max(1, Math.round(v * dpr));

  const canvas = makeCanvas(px(cssW), px(cssH));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = context2d(canvas);

  // 作業用の画面。2D が使えないときは作らない
  let fogTex: HTMLCanvasElement | null = null; // 曇りの下地（大きさごとに一度）
  let fogLayer: HTMLCanvasElement | null = null; // 毎フレームの合成先
  let textLayer: HTMLCanvasElement | null = null; // 文字の形（書き終わった姿。文字が変わるまで不変）
  let maskLayer: HTMLCanvasElement | null = null; // 書き進みの形（左から現れる）
  let wipeLayer: HTMLCanvasElement | null = null; // 拭き取りの形（text × mask）
  let radialSprite: HTMLCanvasElement | null = null; // 広がりの縁の形（一度だけ作る）
  let rampSprite: HTMLCanvasElement | null = null; // 書き進みの先端のぼかし（一度だけ作る）
  const hasCtx = ctx !== null;
  /** 拭き取りの形を作り直さなくてよいか調べるための、前に作ったときの値（書き進み・残り・配置が同じなら前のまま。数で比べる） */
  let wipeVersion = -1;
  let wipeProgress = -1;
  let wipeAmount = -1;
  let layoutVersion = 0;

  let density = 0;
  let ramp: Ramp | null = null;
  let text: TextState | null = null;
  let lastNow = now();
  let dirty = true;
  let disposed = false;
  let raf = 0;

  // ── 描く ──

  const ensureLayers = () => {
    if (!hasCtx || fogLayer) return;
    fogLayer = makeCanvas(canvas.width, canvas.height);
    // 霞と水滴は dpr 1.5 までの細かさで作り、描くときに引き伸ばす
    const k = Math.min(1, FOG_DPR_MAX / dpr);
    fogTex = buildFogTexture(Math.round(canvas.width * k), Math.round(canvas.height * k), dpr * k, tint);
    radialSprite ??= makeRadialSprite();
    rampSprite ??= makeRampSprite();
  };

  /** 文字の canvas は、文字があるあいだだけ持つ（曇りだけの間は解放してメモリを返す） */
  const ensureTextLayers = () => {
    if (!hasCtx || textLayer) return;
    textLayer = makeCanvas(canvas.width, canvas.height);
    maskLayer = makeCanvas(canvas.width, canvas.height);
    wipeLayer = makeCanvas(canvas.width, canvas.height);
    wipeVersion = -1;
  };

  const releaseTextLayers = () => {
    for (const c of [textLayer, maskLayer, wipeLayer]) {
      if (c) {
        c.width = 0;
        c.height = 0;
      }
    }
    textLayer = maskLayer = wipeLayer = null;
    wipeVersion = -1;
  };

  /** 文字を捨てる（拭き取りの跡も、canvas も残さない） */
  const dropText = () => {
    text = null;
    releaseTextLayers();
  };

  /** 文字を配置して、書き終わった姿を textLayer に描く */
  const layoutText = (t: TextState) => {
    const g = textLayer && context2d(textLayer);
    if (!g || !textLayer) return;
    const host = canvas.isConnected
      ? canvas
      : typeof document !== 'undefined'
        ? document.documentElement
        : null;
    const lh = t.opts.lineHeight ?? 1.5;
    const align = t.opts.align ?? 'center';
    const wantFont = t.opts.font ? resolveCssVars(t.opts.font, host) : null;
    // 大きさ: 指定があればそれを上限に、なければ高さから決める。幅に収まらなければ縮める
    const n = Math.max(1, t.lines.length);
    let size = Math.min((wantFont && sizeOf(wantFont)) || Infinity, (cssH * 0.66) / (n * lh), cssW * 0.12);
    // font に大きさ（NNpx）がなければ、書体の指定とみなして大きさを足す
    const specFor = (s: number) =>
      wantFont === null
        ? `400 ${s}px ${DEFAULT_FAMILY}`
        : sizeOf(wantFont) === null
          ? `400 ${s}px ${wantFont}`
          : wantFont.replace(/(\d+(?:\.\d+)?)px/, `${s}px`);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, textLayer.width, textLayer.height);
    g.scale(dpr, dpr);
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    const usable = cssW * 0.86;
    const measure = (s: number) => {
      g.font = specFor(s);
      return t.lines.map((l) => g.measureText(l).width);
    };
    let widths = measure(size);
    const widest = Math.max(...widths, 1);
    if (widest > usable) {
      size *= usable / widest;
      widths = measure(size);
    }
    // 小さくなりすぎない（設計書の最小の文字サイズ。収まらないときは縁で切れる方を選ぶ）
    const minPx = t.opts.minFontPx ?? 18;
    if (size < minPx) {
      size = minPx;
      widths = measure(size);
    }
    const fontSpec = g.font;
    const blockH = n * size * lh;
    const top = (cssH - blockH) / 2;
    const total = t.lines.reduce((s, l) => s + Math.max(1, l.length), 0);
    let acc = 0;
    const spans: [number, number][] = [];
    const lines = t.lines.map((text, i) => {
      const width = widths[i] ?? 0; // widths は lines と同じ長さ（noUncheckedIndexedAccess のための ?? 0）
      const x = align === 'center' ? (cssW - width) / 2 : cssW * 0.07;
      const y = top + (i + 0.5) * size * lh;
      const w = Math.max(1, text.length) / total;
      spans.push([acc, acc + w]);
      acc += w;
      return { text, x, y, width };
    });
    // 指の幅で拭いた形: 太らせた文字（縁を丸める）＋ にじみ（影をぼかして縁に混ぜる）
    g.fillStyle = '#fff';
    g.strokeStyle = '#fff';
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.lineWidth = size * 0.04;
    for (const l of lines) {
      g.shadowColor = 'rgba(255,255,255,0.9)';
      g.shadowBlur = size * 0.12 * dpr;
      g.strokeText(l.text, l.x, l.y);
      g.shadowBlur = 0;
      g.fillText(l.text, l.x, l.y);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    t.layout = { sizePx: size, lineH: size * lh, fontSpec, lines, spans };
    layoutVersion++;
    wipeVersion = -1;
  };

  /** 書き進みの形: 各行を左から、先端をやわらかくぼかして現れさせる */
  const drawMask = (t: TextState) => {
    const lay = t.layout;
    const g = maskLayer && context2d(maskLayer);
    if (!lay || !g || !maskLayer) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, maskLayer.width, maskLayer.height);
    g.scale(dpr, dpr);
    const soft = lay.sizePx * 0.9; // 先端のぼかしの幅
    lay.lines.forEach((l, i) => {
      const span = lay.spans[i];
      if (!span) return;
      const [a, b] = span;
      const lp = clamp01((t.progress - a) / (b - a));
      if (lp <= 0) return;
      const x0 = l.x - lay.sizePx * 0.4;
      const x1 = l.x + l.width + lay.sizePx * 0.4;
      const front = x0 + (x1 - x0 + soft) * lp; // 先端（右端を越えて抜けきる）
      // その行の帯だけ（隣の行は別の区間で書く）。先端の手前は塗りつぶし、先端はぼかしの帯を伸ばして貼る
      const top = l.y - lay.lineH / 2;
      g.fillStyle = '#fff';
      if (front - soft > 0) g.fillRect(0, top, front - soft, lay.lineH);
      if (rampSprite) g.drawImage(rampSprite, front - soft, top, soft, lay.lineH);
    });
    g.setTransform(1, 0, 0, 1, 0, 0);
  };

  const draw = () => {
    dirty = false;
    if (!ctx) return;
    ensureLayers();
    if (!fogLayer || !fogTex) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (density <= 0.0005) {
      opts.onDraw?.();
      return;
    }
    const fg = context2d(fogLayer);
    if (!fg) return;

    // 1. 曇りの下地を、密度に応じた濃さで置く
    fg.globalCompositeOperation = 'source-over';
    fg.clearRect(0, 0, W, H);
    fg.globalAlpha = smoothstep(0, 0.3, density);
    fg.drawImage(fogTex, 0, 0, W, H);
    fg.globalAlpha = 1;

    // 2. 中心から広がる（縁は蒸発が早いので、晴れるときは縁から消える）。縁の形の絵を大きさを変えて貼る
    if (density < 0.999 && radialSprite) {
      const maxR = Math.hypot(W, H) / 2;
      // 内側の 62% が完全に覆うので、密度 1 に近づいたとき四隅まで届く大きさ（maxR / 0.62 より大きく）
      const r = Math.max(1, maxR * 1.65 * density ** 0.85);
      fg.globalCompositeOperation = 'destination-in';
      fg.globalAlpha = smoothstep(0, 0.2, density);
      fg.drawImage(radialSprite, W / 2 - r, H / 2 - r, r * 2, r * 2);
      fg.globalAlpha = 1;
      fg.globalCompositeOperation = 'source-over';
    }

    // 3. 指でなぞった所を拭き取る
    if (text?.layout && text.progress > 0 && text.amount > 0.002 && textLayer && maskLayer && wipeLayer) {
      const wg = context2d(wipeLayer);
      if (!wg) return;
      // 書き進みも残りも配置も変わっていなければ、拭き取りの形は前のまま使う（曇りだけが動く間は作り直さない）
      if (wipeVersion !== layoutVersion || wipeProgress !== text.progress || wipeAmount !== text.amount) {
        wipeVersion = layoutVersion;
        wipeProgress = text.progress;
        wipeAmount = text.amount;
        drawMask(text);
        wg.setTransform(1, 0, 0, 1, 0, 0);
        wg.globalCompositeOperation = 'source-over';
        wg.clearRect(0, 0, W, H);
        // 曇りに溶けていくときは、輪郭もにじませる（ctx.filter が使える環境だけ）
        const melt = 1 - text.amount;
        if (melt > 0.01 && 'filter' in wg)
          (wg as CanvasRenderingContext2D & { filter: string }).filter =
            `blur(${(melt * text.layout.sizePx * 0.35 * dpr).toFixed(1)}px)`;
        wg.drawImage(textLayer, 0, 0);
        if ('filter' in wg) (wg as CanvasRenderingContext2D & { filter: string }).filter = 'none';
        wg.globalCompositeOperation = 'destination-in';
        wg.drawImage(maskLayer, 0, 0);
        wg.globalCompositeOperation = 'source-over';
      }

      // 拭いた縁に水が寄って白くなる（文字のまわりが少し白く縁取られ、澄んだ線が読みやすくなる）
      const reach = text.layout.sizePx * 0.07 * dpr;
      fg.globalCompositeOperation = 'source-atop';
      fg.globalAlpha = clamp01(text.amount) * 0.1;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        fg.drawImage(wipeLayer, Math.cos(a) * reach, Math.sin(a) * reach);
      }
      fg.globalCompositeOperation = 'destination-out';
      fg.globalAlpha = clamp01(text.amount) * 0.96;
      fg.drawImage(wipeLayer, 0, 0);
      fg.globalAlpha = 1;
      fg.globalCompositeOperation = 'source-over';
    }

    ctx.drawImage(fogLayer, 0, 0);
    opts.onDraw?.();
  };

  // ── 時間 ──

  const busy = () => ramp !== null || (text !== null && (text.written !== null || text.erasing !== null));

  const advance = (t: number) => {
    lastNow = t;
    let changed = false;

    if (ramp) {
      const p = ramp.dur <= 0 ? 1 : clamp01((t - ramp.start) / ramp.dur);
      density = ramp.from + (ramp.to - ramp.from) * easeInOutSine(p);
      changed = true;
      if (p >= 1) {
        density = ramp.to;
        const done = ramp.done;
        ramp = null;
        // 晴れきったら、拭き取りの跡も残さない（次に曇ったとき文字だけ澄んでいるのは不自然）
        if (density === 0 && text) {
          text.written?.();
          text.erasing?.done();
          dropText();
        }
        done();
      }
    }

    if (text) {
      const tx = text;
      if (tx.written) {
        const p = tx.dur <= 0 ? 1 : clamp01((t - tx.start) / tx.dur);
        tx.progress = p;
        changed = true;
        if (p >= 1) {
          const done = tx.written;
          tx.written = null;
          done();
        }
      }
      if (text && tx.erasing) {
        const e = tx.erasing;
        const p = e.dur <= 0 ? 1 : clamp01((t - e.start) / e.dur);
        tx.amount = e.from * (1 - easeInOutSine(p));
        changed = true;
        if (p >= 1) {
          if (text === tx) dropText();
          e.done();
        }
      }
    }

    if (changed || dirty) draw();
  };

  const schedule = () => {
    if (!autoTick || disposed || raf || typeof requestAnimationFrame !== 'function') return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (disposed) return;
      advance(now());
      if (busy()) schedule();
    });
  };

  /** 進行中の約束をすべて果たして止める（上書きされたとき、破棄されたときに約束が宙に浮かないように） */
  const settleRamp = () => {
    const r = ramp;
    ramp = null;
    r?.done();
  };

  const startRamp = (to: number, durationSec: number): Promise<void> => {
    settleRamp();
    return new Promise<void>((resolve) => {
      if (durationSec <= 0) {
        density = to;
        if (to === 0 && text) {
          text.written?.();
          text.erasing?.done();
          dropText();
        }
        dirty = true;
        advance(lastNow);
        resolve();
        return;
      }
      ramp = { from: density, to, start: now(), dur: durationSec, done: resolve };
      schedule();
    });
  };

  // ── 公開 ──

  return {
    canvas,
    get density() {
      return density;
    },

    fogIn: (durationSec) => startRamp(1, durationSec),
    clear: (durationSec) => startRamp(0, durationSec),

    write(lines, o = {}) {
      // 書き直し: 前の文字は約束を果たして置き換える
      text?.written?.();
      text?.erasing?.done();
      return new Promise<void>((resolve) => {
        const t: TextState = {
          lines,
          opts: o,
          layout: null,
          start: now(),
          dur: Math.max(0, o.durationSec ?? Math.max(1.2, lines.join('').length * 0.22)),
          progress: 0,
          amount: 1,
          written: resolve,
          erasing: null,
        };
        text = t;
        if (hasCtx && !disposed) {
          ensureLayers();
          ensureTextLayers();
          layoutText(t);
          // フォントが読み込まれてから描き直す（読み込み前は代わりの書体で出てしまう）
          const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
          if (t.layout && fonts && !fonts.check(t.layout.fontSpec, lines.join(''))) {
            void fonts.load(t.layout.fontSpec, lines.join('')).then(() => {
              if (text === t && !disposed) {
                layoutText(t);
                dirty = true;
                if (!autoTick) return;
                advance(now());
              }
            });
          }
        }
        dirty = true;
        schedule();
      });
    },

    erase(durationSec) {
      return new Promise<void>((resolve) => {
        const t = text;
        if (!t) {
          resolve();
          return;
        }
        // 書いている途中なら、そこで書くのをやめて溶かし始める
        t.written?.();
        t.written = null;
        t.erasing?.done();
        if (durationSec <= 0) {
          dropText();
          dirty = true;
          advance(lastNow);
          resolve();
          return;
        }
        t.erasing = { start: now(), dur: durationSec, from: t.amount, done: resolve };
        schedule();
      });
    },

    tick(t) {
      if (disposed) return;
      advance(t);
    },

    resize(width, height, nextDpr) {
      cssW = width;
      cssH = height;
      dpr = nextDpr;
      canvas.width = px(cssW);
      canvas.height = px(cssH);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      // 作り直し（canvas の大きさを変えると中身は消える）
      fogTex = fogLayer = null;
      releaseTextLayers();
      if (text) {
        text.layout = null;
        if (hasCtx) {
          ensureLayers();
          ensureTextLayers();
          layoutText(text);
        }
      }
      dirty = true;
      if (!disposed) advance(lastNow);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
      // 待っている相手が宙に浮かないよう、約束は果たしてから片付ける
      const r = ramp;
      ramp = null;
      const t = text;
      dropText();
      r?.done();
      t?.written?.();
      t?.erasing?.done();
      fogTex = fogLayer = radialSprite = rampSprite = null;
    },
  };
}
