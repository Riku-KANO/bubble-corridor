// 確認ページの仮の写真（canvas で描いた絵）。本物は src/photo が描く。
import type { ShotId } from '../../contracts/ids';

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

export function makePhoto(shot: ShotId, w: number, h: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('canvas を使えません'));
  const r = rng(shot === 'bloom' ? 11 : shot === 'freeze' ? 23 : 37);

  if (shot === 'bloom') {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#f6f2c8');
    g.addColorStop(0.6, '#9fd08a');
    g.addColorStop(1, '#2f6a4a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 5; i++) {
      const x = w * (0.1 + i * 0.2);
      const lg = ctx.createLinearGradient(x, 0, x + w * 0.2, h);
      lg.addColorStop(0, 'rgba(255,250,200,0.5)');
      lg.addColorStop(1, 'rgba(255,250,200,0)');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + w * 0.06, 0);
      ctx.lineTo(x + w * 0.28, h);
      ctx.lineTo(x + w * 0.18, h);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    // ガラスの花
    ctx.save();
    ctx.translate(w * 0.5, h * 0.52);
    for (let i = 0; i < 12; i++) {
      ctx.rotate((Math.PI * 2) / 12);
      const pg = ctx.createRadialGradient(0, -h * 0.16, 0, 0, -h * 0.16, h * 0.2);
      pg.addColorStop(0, 'rgba(255,255,255,0.85)');
      pg.addColorStop(1, 'rgba(210,240,255,0.15)');
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.ellipse(0, -h * 0.17, h * 0.07, h * 0.19, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.stroke();
    }
    ctx.restore();
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.3 + r() * 0.5})`;
      ctx.beginPath();
      ctx.arc(r() * w, r() * h, 2 + r() * 5, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (shot === 'freeze') {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#7f93a6');
    g.addColorStop(1, '#3b4a5c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 18; i++) {
      const x = r() * w;
      const y = h * (0.1 + r() * 0.6);
      const rad = 20 + r() * 50;
      const lg = ctx.createRadialGradient(x, y, 0, x, y, rad * 3);
      lg.addColorStop(0, 'rgba(255,190,100,0.55)');
      lg.addColorStop(1, 'rgba(255,190,100,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(x - rad * 3, y - rad * 3, rad * 6, rad * 6);
    }
    // 止まった雨粒（ガラス玉）
    for (let i = 0; i < 70; i++) {
      const x = r() * w;
      const y = r() * h;
      const rad = 6 + r() * 22;
      const bg = ctx.createRadialGradient(x - rad * 0.3, y - rad * 0.3, 0, x, y, rad);
      bg.addColorStop(0, 'rgba(255,255,255,0.9)');
      bg.addColorStop(0.35, 'rgba(200,225,250,0.35)');
      bg.addColorStop(1, 'rgba(120,160,210,0.25)');
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.stroke();
    }
  } else {
    const g = ctx.createRadialGradient(w / 2, h * 0.6, 0, w / 2, h * 0.6, h);
    g.addColorStop(0, '#2a3b8a');
    g.addColorStop(1, '#070a1f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const stars: [number, number][] = [];
    for (let i = 0; i < 16; i++) stars.push([w * (0.12 + (i / 15) * 0.76), h * (0.62 - Math.abs(Math.sin(i * 1.7)) * 0.34)]);
    ctx.strokeStyle = 'rgba(255,236,190,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    stars.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
    for (let i = 0; i < 220; i++) {
      ctx.fillStyle = `rgba(255,248,230,${0.2 + r() * 0.7})`;
      ctx.beginPath();
      ctx.arc(r() * w, r() * h, 0.6 + r() * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const [x, y] of stars) {
      const sg = ctx.createRadialGradient(x, y, 0, x, y, 26);
      sg.addColorStop(0, 'rgba(255,245,210,1)');
      sg.addColorStop(1, 'rgba(255,230,170,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(x - 26, y - 26, 52, 52);
    }
  }
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像にできませんでした'))), 'image/png'));
}
