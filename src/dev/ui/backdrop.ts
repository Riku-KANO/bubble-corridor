// 確認ページの後ろの景色（本番では 3D の部屋）。ガラスの透け方や読みやすさを見るための仮の絵。
import type { ScreenId } from '../../contracts/ui';

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

type Scene = 'dark' | 'lobby' | 'platform' | 'greenhouse' | 'dawn';
const SCENE_OF: Record<ScreenId, Scene> = {
  queue: 'dark',
  home: 'lobby',
  guide: 'platform',
  riding: 'greenhouse',
  pause: 'greenhouse',
  photo: 'dawn',
  shelf: 'dawn',
  settings: 'lobby',
  howto: 'lobby',
  credits: 'lobby',
};

export function drawBackdrop(canvas: HTMLCanvasElement, screen: ScreenId): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(innerWidth * dpr));
  const h = Math.max(1, Math.round(innerHeight * dpr));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const scene = SCENE_OF[screen];
  const r = rng(7);
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  const stops: Record<Scene, [number, string][]> = {
    dark: [[0, '#05070f'], [1, '#0a0f1e']],
    lobby: [[0, '#0b1330'], [0.5, '#1d3a7a'], [0.62, '#6f8fd0'], [0.63, '#1a2a52'], [1, '#0a1226']],
    platform: [[0, '#1a2640'], [0.55, '#4b6389'], [0.56, '#2a3956'], [1, '#141c30']],
    greenhouse: [[0, '#e9f3c8'], [0.5, '#9fd18a'], [0.55, '#5b9a6a'], [1, '#2c5a44']],
    dawn: [[0, '#0e1440'], [0.35, '#5b4a86'], [0.55, '#f0a0a8'], [0.62, '#ffd48a'], [0.63, '#b6865a'], [1, '#54455c']],
  };
  for (const [at, color] of stops[scene]) sky.addColorStop(at, color);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const glow = (x: number, y: number, rad: number, color: string, alpha: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, color.replace('A', String(alpha)));
    g.addColorStop(1, color.replace('A', '0'));
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  };

  if (scene === 'lobby' || scene === 'platform') {
    // 天井の乳白の灯りと、ぼけた光
    for (let i = 0; i < 7; i++) glow((w * (i + 0.5)) / 7, h * 0.08, h * 0.35, 'rgba(210,225,255,A)', 0.4);
    for (let i = 0; i < 26; i++) glow(r() * w, h * (0.25 + r() * 0.45), 30 + r() * 90 * dpr, 'rgba(160,190,255,A)', 0.1 + r() * 0.18);
    if (scene === 'platform') {
      for (let i = 0; i < 6; i++) {
        const x = w * (0.1 + r() * 0.8);
        const y = h * (0.25 + r() * 0.3);
        const rad = (40 + r() * 60) * dpr;
        const g = ctx.createRadialGradient(x - rad * 0.3, y - rad * 0.3, 0, x, y, rad);
        g.addColorStop(0, 'rgba(255,255,255,0.7)');
        g.addColorStop(0.3, 'rgba(190,215,255,0.25)');
        g.addColorStop(1, 'rgba(150,185,240,0.05)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (scene === 'greenhouse') {
    // 斜めに差し込む朝日と、ガラスの葉
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 6; i++) {
      const x = w * (0.1 + i * 0.16);
      const g = ctx.createLinearGradient(x, 0, x + w * 0.2, h);
      g.addColorStop(0, 'rgba(255,248,200,0.5)');
      g.addColorStop(1, 'rgba(255,248,200,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + w * 0.07, 0);
      ctx.lineTo(x + w * 0.3, h);
      ctx.lineTo(x + w * 0.2, h);
      ctx.fill();
    }
    ctx.restore();
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(${70 + r() * 60},${150 + r() * 80},${90 + r() * 50},${0.25 + r() * 0.3})`;
      ctx.beginPath();
      ctx.ellipse(r() * w, h * (0.2 + r() * 0.7), (30 + r() * 90) * dpr, (14 + r() * 40) * dpr, r() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (scene === 'dawn') {
    glow(w * 0.5, h * 0.62, h * 0.6, 'rgba(255,214,140,A)', 0.8);
    for (let i = 0; i < 70; i++) {
      ctx.fillStyle = `rgba(255,255,255,${r() * 0.7})`;
      ctx.fillRect(r() * w, r() * h * 0.4, dpr, dpr);
    }
    // 水面のきらめき
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(255,230,170,${0.15 + r() * 0.3})`;
      ctx.fillRect(w * (0.3 + r() * 0.4), h * (0.64 + r() * 0.3), (20 + r() * 80) * dpr, 2 * dpr);
    }
  } else {
    glow(w * 0.5, h * 0.46, h * 0.5, 'rgba(110,140,210,A)', 0.18);
  }
}
