// 合成: 撮影した画像に、額縁・扉の色のさし色・刻印を 2D で重ねて、保存の形の PNG にする。
// 額縁は隠れた泡の数で 4 種（通常のガラスの縁、銀、金、虹色の薄膜）。見た目の確認は dev/photo.html。
import type { FrameTier, PhotoFormat, PhotoMeta } from '../contracts/photo';
import { cropFor, doorTint, frameTierFor, stampText } from './rules';

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
type Surface = OffscreenCanvas | HTMLCanvasElement;

/** 細い明朝。入口の画面と同じ書体（Zen Old Mincho）を先に使い、なければ端末の明朝 */
const SERIF = '"Zen Old Mincho", "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif';

/** 額縁の太さ（短い辺が 1080px のときの px）。隠れた泡が多いほど立派にする */
const FRAME_WIDTH: Readonly<Record<FrameTier, number>> = { plain: 14, silver: 30, gold: 34, rainbow: 40 };

/** 額縁・刻印・扉の色を合成して、保存の形（横長 1920×1080 / 正方形 1080×1080）の画像にする */
export async function composePhoto(image: Blob, meta: PhotoMeta, format: PhotoFormat): Promise<Blob> {
  const bitmap = await createImageBitmap(image);
  try {
    const crop = cropFor(format, bitmap.width, bitmap.height);
    const { width: w, height: h } = crop;
    const { surface, ctx } = createSurface(w, h);
    const u = Math.min(w, h) / 1080;
    const tier = frameTierFor(meta.hiddenTotal);
    const tint = doorTint(meta.door);
    const frame = FRAME_WIDTH[tier] * u;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);

    paintDoorTint(ctx, w, h, tint);
    paintFrame(ctx, w, h, tier, frame, u, tint);
    await paintStamp(ctx, w, h, stampText(meta, meta.lang), frame, u);
    return await toBlob(surface);
  } finally {
    bitmap.close();
  }
}

function createSurface(w: number, h: number): { surface: Surface; ctx: Ctx } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const surface = new OffscreenCanvas(w, h);
    const ctx = surface.getContext('2d');
    if (ctx) return { surface, ctx };
  }
  const surface = document.createElement('canvas');
  surface.width = w;
  surface.height = h;
  const ctx = surface.getContext('2d');
  if (!ctx) throw new Error('2D キャンバスを作れません');
  return { surface, ctx };
}

function toBlob(surface: Surface): Promise<Blob> {
  if ('convertToBlob' in surface) return surface.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    surface.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG に変換できません'))), 'image/png');
  });
}

/** '#rrggbb' と 0〜1 の不透明度から CSS の色 */
function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const WHITE = (a: number) => `rgba(255, 255, 255, ${a})`;
const BLACK = (a: number) => `rgba(0, 0, 0, ${a})`;

/** 扉の色のさし色。中央はそのままに、四隅へ向けて薄く染める（景色の色を濁らせない） */
function paintDoorTint(ctx: Ctx, w: number, h: number, tint: string): void {
  const r = Math.hypot(w, h) / 2;
  const g = ctx.createRadialGradient(w / 2, h / 2, r * 0.45, w / 2, h / 2, r);
  g.addColorStop(0, rgba(tint, 0));
  g.addColorStop(1, rgba(tint, 1));
  ctx.save();
  ctx.fillStyle = g;
  ctx.globalAlpha = 0.28;
  ctx.globalCompositeOperation = 'soft-light';
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 0.1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ── 額縁 ─────────────────────────────────────────────────────

/** 額縁の 4 辺（斜めに切った台形）。光は左上から当たる */
function sides(w: number, h: number, t: number): { top: Path2D; right: Path2D; bottom: Path2D; left: Path2D } {
  const poly = (...p: number[]) => {
    const path = new Path2D();
    path.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) path.lineTo(p[i], p[i + 1]);
    path.closePath();
    return path;
  };
  return {
    top: poly(0, 0, w, 0, w - t, t, t, t),
    right: poly(w, 0, w, h, w - t, h - t, w - t, t),
    bottom: poly(0, h, w, h, w - t, h - t, t, h - t),
    left: poly(0, 0, t, t, t, h - t, 0, h),
  };
}

function ring(w: number, h: number, t: number): Path2D {
  const path = new Path2D();
  path.rect(0, 0, w, h);
  path.rect(t, t, w - 2 * t, h - 2 * t);
  return path;
}

function diagonal(ctx: Ctx, w: number, h: number, stops: readonly (readonly [number, string])[]): CanvasGradient {
  const g = ctx.createLinearGradient(0, 0, w, h);
  for (const [at, color] of stops) g.addColorStop(at, color);
  return g;
}

function paintFrame(ctx: Ctx, w: number, h: number, tier: FrameTier, t: number, u: number, tint: string): void {
  ctx.save();

  // 写真を額縁の内側へはめ込んだ陰影（金属の額縁ほど深く）
  const depth = tier === 'plain' ? 0.1 : 0.26;
  const shade = Math.max(8 * u, t * 0.45);
  // 内側の縁から写真の側へ向けて暗さが抜けていく帯
  const band = (x: number, y: number, bw: number, bh: number, fromX: number, fromY: number, toX: number, toY: number, alpha: number) => {
    const g = ctx.createLinearGradient(fromX, fromY, toX, toY);
    g.addColorStop(0, BLACK(alpha));
    g.addColorStop(1, BLACK(0));
    ctx.fillStyle = g;
    ctx.fillRect(x, y, bw, bh);
  };
  band(t, t, w - 2 * t, shade, t, t, t, t + shade, depth); // 上
  band(t, h - t - shade, w - 2 * t, shade, t, h - t, t, h - t - shade, depth); // 下
  band(t, t, shade, h - 2 * t, t, t, t + shade, t, depth * 0.8); // 左
  band(w - t - shade, t, shade, h - 2 * t, w - t, t, w - t - shade, t, depth * 0.8); // 右

  const faces = sides(w, h, t);
  const base = ring(w, h, t);
  ctx.fillStyle = baseFill(ctx, w, h, tier);
  ctx.fill(base, 'evenodd');

  // 面取り: 上と左は明るく、下と右は暗く
  const bevel = tier === 'plain' ? 0.5 : 1;
  const lit = (path: Path2D, color: string) => {
    ctx.fillStyle = color;
    ctx.fill(path);
  };
  lit(faces.top, WHITE(0.34 * bevel));
  lit(faces.left, WHITE(0.18 * bevel));
  lit(faces.bottom, BLACK(0.26 * bevel));
  lit(faces.right, BLACK(0.14 * bevel));

  if (tier === 'rainbow') {
    // 薄膜のつや: 斜めに走る白い光沢を重ねて、色が面の上を滑って見えるようにする
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.fillStyle = diagonal(ctx, w, h, [
      [0, WHITE(0.55)],
      [0.35, WHITE(0)],
      [0.65, WHITE(0.4)],
      [1, WHITE(0)],
    ]);
    ctx.fill(base, 'evenodd');
    ctx.restore();
  }

  hairlines(ctx, w, h, tier, t, u);
  if (tier === 'rainbow') sparkles(ctx, w, h, t, u);

  // 扉の色: 額縁の内側の縁に、さし色の細い光（写真の側へだけにじませる）
  ctx.beginPath();
  ctx.rect(t, t, w - 2 * t, h - 2 * t);
  ctx.clip();
  ctx.strokeStyle = rgba(tint, 0.7);
  ctx.lineWidth = 3 * u;
  ctx.shadowColor = rgba(tint, 0.85);
  ctx.shadowBlur = 22 * u;
  ctx.strokeRect(t, t, w - 2 * t, h - 2 * t);

  ctx.restore();
}

function baseFill(ctx: Ctx, w: number, h: number, tier: FrameTier): CanvasGradient | string {
  switch (tier) {
    case 'plain':
      // 透明なガラスの縁: ほとんど透けて、光の筋だけが乗る
      return diagonal(ctx, w, h, [
        [0, WHITE(0.3)],
        [0.35, WHITE(0.08)],
        [0.65, WHITE(0.14)],
        [1, WHITE(0.28)],
      ]);
    case 'silver':
      return diagonal(ctx, w, h, [
        [0, '#f8fafc'],
        [0.16, '#b7c0ca'],
        [0.34, '#eef1f5'],
        [0.52, '#8c97a3'],
        [0.7, '#dde2e8'],
        [0.86, '#a4aeb9'],
        [1, '#eef1f5'],
      ]);
    case 'gold':
      return diagonal(ctx, w, h, [
        [0, '#fff6c9'],
        [0.16, '#dfb247'],
        [0.34, '#fff0ac'],
        [0.52, '#a9761c'],
        [0.7, '#f4d072'],
        [0.86, '#9a6a14'],
        [1, '#ffe9a0'],
      ]);
    case 'rainbow':
      // シャボン玉の薄膜の色。中心から一周させる
      return conic(ctx, w, h, [
        [0, '#ff93d2'],
        [0.14, '#ffd77d'],
        [0.29, '#b9ff9e'],
        [0.43, '#76f1ff'],
        [0.57, '#8d9cff'],
        [0.71, '#d98fff'],
        [0.86, '#ff93a9'],
        [1, '#ff93d2'],
      ]);
  }
}

function conic(ctx: Ctx, w: number, h: number, stops: readonly (readonly [number, string])[]): CanvasGradient {
  const g = 'createConicGradient' in ctx ? ctx.createConicGradient(Math.PI * 0.25, w / 2, h / 2) : diagonal(ctx, w, h, stops);
  for (const [at, color] of stops) g.addColorStop(at, color);
  return g;
}

/** 縁の細い線（外側の暗い線、内側の明るい線と暗い線） */
function hairlines(ctx: Ctx, w: number, h: number, tier: FrameTier, t: number, u: number): void {
  const metal = tier !== 'plain';
  ctx.lineWidth = 1.5 * u;
  ctx.strokeStyle = metal ? BLACK(0.42) : WHITE(0.55);
  ctx.strokeRect(0.75 * u, 0.75 * u, w - 1.5 * u, h - 1.5 * u);
  ctx.strokeStyle = metal ? WHITE(0.75) : WHITE(0.7);
  ctx.strokeRect(t - 0.75 * u, t - 0.75 * u, w - 2 * t + 1.5 * u, h - 2 * t + 1.5 * u);
  if (metal) {
    // 金属の縁の中ほどに、もう 1 本の線を引いて厚みを出す
    ctx.lineWidth = 1 * u;
    ctx.strokeStyle = BLACK(0.2);
    const m = t * 0.5;
    ctx.strokeRect(m, m, w - 2 * m, h - 2 * m);
    ctx.strokeStyle = WHITE(0.28);
    ctx.strokeRect(m + u, m + u, w - 2 * m - 2 * u, h - 2 * m - 2 * u);
  } else {
    // ガラスの縁の屈折: 内側に薄い線をもう 1 本
    ctx.lineWidth = 1 * u;
    ctx.strokeStyle = WHITE(0.25);
    const m = t * 0.45;
    ctx.strokeRect(m, m, w - 2 * m, h - 2 * m);
  }
}

/** 虹色の額縁の四隅に、小さな光の星 */
function sparkles(ctx: Ctx, w: number, h: number, t: number, u: number): void {
  const spots: readonly (readonly [number, number, number])[] = [
    [t * 0.5, t * 0.5, 1],
    [w - t * 0.5, t * 0.5, 0.7],
    [t * 0.5, h - t * 0.5, 0.7],
    [w - t * 0.5, h - t * 0.5, 1],
  ];
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const [x, y, k] of spots) {
    const r = 20 * u * k;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, WHITE(0.95));
    glow.addColorStop(1, WHITE(0));
    ctx.fillStyle = glow;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    ctx.strokeStyle = WHITE(0.9);
    ctx.lineWidth = 1.5 * u;
    ctx.beginPath();
    ctx.moveTo(x - r * 1.1, y);
    ctx.lineTo(x + r * 1.1, y);
    ctx.moveTo(x, y - r * 1.1);
    ctx.lineTo(x, y + r * 1.1);
    ctx.stroke();
  }
  ctx.restore();
}

// ── 刻印 ─────────────────────────────────────────────────────

/** 刻印を右下に小さく、細い明朝で。景色が明るくても読めるよう、ごく淡い影を敷く */
async function paintStamp(ctx: Ctx, w: number, h: number, text: string, frame: number, u: number): Promise<void> {
  const size = Math.round(22 * u);
  const font = `400 ${size}px ${SERIF}`;
  await ensureFont(font, text);

  ctx.save();
  ctx.font = font;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(size * 0.1).toFixed(1)}px`;
  ctx.shadowColor = BLACK(0.6);
  ctx.shadowBlur = 8 * u;
  ctx.shadowOffsetY = 1 * u;
  ctx.fillStyle = WHITE(0.92);
  ctx.fillText(text, w - frame - 30 * u, h - frame - 26 * u);
  ctx.restore();
}

/** 書体がまだ読み込まれていないと、代わりの書体で刻印されてしまう。使う文字の分だけ先に読む */
async function ensureFont(font: string, text: string): Promise<void> {
  const fonts = (globalThis as { document?: { fonts?: { load(font: string, text?: string): Promise<unknown> } } }).document?.fonts;
  try {
    await fonts?.load(font, text);
  } catch {
    // 読めなければ代わりの書体で刻印する
  }
}
