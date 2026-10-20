// VR のメニュー（曇りガラスの板）。canvas に描いた文字を板の材質にする（生の HTML は使わない）。
// 文字は画面版の約2倍（XR.textScale）。板の座標は中心が原点、+X が右、+Y が上（m）。
import * as THREE from 'three/webgpu';
import { menuTextHeight } from './logic';
import { XR_TUNING } from './tuning';

export interface MenuItem {
  readonly id: string;
  readonly label: string;
}

export interface MenuPanel {
  readonly mesh: THREE.Mesh;
  /** 項目を描き直し、板の大きさを合わせる */
  setItems(items: readonly MenuItem[]): void;
  /** 指す・見つめている項目を明るくする（-1 でなし）。変わったときだけ描き直す */
  setHover(index: number): void;
  /** 選んだ項目を一瞬強く光らせる */
  flash(index: number): void;
  /**
   * 見つめた進み具合（0〜1）を、その項目の上に塗りで見せる（-1 か 0 で消す）。
   * 板は描き直さず、項目に重ねた細長い板の長さだけを変える（毎フレーム呼んでよい）。
   */
  setProgress(index: number, progress: number): void;
  /** 不透明度 0 のまま見えるようにする（開始前の compileAsync 用）。false で元に戻す */
  prewarm(on: boolean): void;
  /** 板の座標の点が当たる項目の番号（なければ -1） */
  hit(x: number, y: number): number;
  readonly width: number;
  readonly height: number;
  dispose(): void;
}

const CANVAS_W = 1024;
/**
 * canvas の大きさは最初から最後まで固定にする（項目の数で変えない）。
 * 一度 GPU に上げたテクスチャの大きさは変えられず、canvas を大きくすると
 * 「Offset overflows texture dimensions」の警告が出て描けないため。板は上の一部を使い、UV で切り出す。
 */
const CANVAS_H = 1280;
/** 板に出せる項目の最大（canvas の高さに収まる数）。超えた分は出さない */
const MAX_ITEMS = 8;
const FONT = '"Noto Sans JP", "Zen Old Mincho", "Hiragino Sans", sans-serif';

export function createMenu(): MenuPanel {
  const W = XR_TUNING.menuWidth;
  const font = menuTextHeight();
  const rowH = font * 2.2;
  const gap = font * 0.5;
  const pad = font * 1.0;

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new THREE.MeshBasicNodeMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, 0.1), material);
  mesh.name = 'xr-menu';
  mesh.renderOrder = 9_000;
  mesh.visible = false;

  // 見つめた進み具合の塗り。項目の左端から伸びる細長い板（板の子なので、板と一緒に動く）
  const fillMaterial = new THREE.MeshBasicNodeMaterial({
    color: 0xf2cf94,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const fillGeometry = new THREE.PlaneGeometry(1, 1);
  const fill = new THREE.Mesh(fillGeometry, fillMaterial);
  fill.name = 'xr-menu-progress';
  fill.renderOrder = 9_001;
  fill.frustumCulled = false;
  fill.visible = false;
  mesh.add(fill);

  let items: readonly MenuItem[] = [];
  let hover = -1;
  let flashIndex = -1;
  let height = 0.1;

  // 曇りのざらつきは、描き直すたびに同じ種から始める（ホバーで描き直しても模様が変わらず、ちらつかない）
  const NOISE_SEED = 12345;
  function createNoise() {
    let s = NOISE_SEED;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function rowTop(i: number): number {
    return height / 2 - pad - i * (rowH + gap);
  }

  function draw() {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const noise = createNoise();
    const ppm = CANVAS_W / W; // 1m あたりの画素
    const w = CANVAS_W;
    const h = Math.min(CANVAS_H, Math.ceil(height * ppm)); // 板が使う上の部分
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 板: 青灰の曇りガラス。上の左から光が差す
    const r = font * 0.9 * ppm;
    roundRect(ctx, 2, 2, w - 4, h - 4, r);
    const base = ctx.createLinearGradient(0, 0, w, h);
    // 不透明度は 0.85 前後（背景が透けても文字が読める）
    base.addColorStop(0, 'rgba(58,78,106,0.84)');
    base.addColorStop(1, 'rgba(30,44,66,0.88)');
    ctx.fillStyle = base;
    ctx.fill();
    ctx.save();
    ctx.clip();
    // 曇りの粒
    for (let i = 0; i < 1600; i++) {
      const a = 0.025 + noise() * 0.05;
      ctx.fillStyle = `rgba(235,244,255,${a.toFixed(3)})`;
      ctx.fillRect(noise() * w, noise() * h, 1 + noise() * 2, 1 + noise() * 2);
    }
    const sheen = ctx.createLinearGradient(0, 0, w * 0.6, h * 0.5);
    sheen.addColorStop(0, 'rgba(255,255,255,0.16)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    // 縁（白い光）と真鍮の細い線
    roundRect(ctx, 2, 2, w - 4, h - 4, r);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(235,244,255,0.55)';
    ctx.stroke();
    roundRect(ctx, 10, 10, w - 20, h - 20, r * 0.85);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(176,141,87,0.7)';
    ctx.stroke();

    // 項目
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `400 ${(font * ppm).toFixed(1)}px ${FONT}`;
    for (let i = 0; i < items.length; i++) {
      const top = (height / 2 - rowTop(i)) * ppm; // 画像の上端からの画素
      const x = pad * ppm;
      const rw = w - 2 * pad * ppm;
      const rh = rowH * ppm;
      roundRect(ctx, x, top, rw, rh, rh * 0.35);
      const lit = i === flashIndex ? 0.5 : i === hover ? 0.28 : 0.1;
      ctx.fillStyle = `rgba(255,255,255,${lit})`;
      ctx.fill();
      if (i === hover || i === flashIndex) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(214,176,112,0.95)';
        ctx.stroke();
      }
      ctx.shadowColor = 'rgba(10,20,40,0.5)';
      ctx.shadowBlur = 6;
      ctx.fillStyle = 'rgba(250,252,255,0.97)';
      ctx.fillText(items[i].label, w / 2, top + rh / 2 + font * ppm * 0.04, rw - font * ppm * 1.2);
      ctx.shadowBlur = 0;
    }
    texture.needsUpdate = true;
  }

  return {
    mesh,
    setItems(next) {
      items = next.slice(0, MAX_ITEMS);
      hover = -1;
      flashIndex = -1;
      height = pad * 2 + items.length * rowH + Math.max(0, items.length - 1) * gap;
      mesh.geometry.dispose();
      const geometry = new THREE.PlaneGeometry(W, height);
      // 板は canvas の上の部分だけを使うので、UV の縦をその範囲に縮める（画像の上端が v=1）
      const used = Math.min(1, Math.ceil(height * (CANVAS_W / W)) / CANVAS_H);
      const uv = geometry.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - (1 - uv.getY(i)) * used);
      mesh.geometry = geometry;
      draw();
    },
    setHover(index) {
      if (index === hover) return;
      hover = index;
      draw();
    },
    flash(index) {
      flashIndex = index;
      draw();
      // 次の setHover / flash で戻す。一瞬だけ強く見せる
      setTimeout(() => {
        if (flashIndex === index) {
          flashIndex = -1;
          draw();
        }
      }, 180);
    },
    setProgress(index, progress) {
      if (index < 0 || index >= items.length || progress <= 0) {
        fill.visible = false;
        return;
      }
      const rw = W - 2 * pad;
      const p = progress >= 1 ? 1 : progress;
      fill.visible = true;
      fill.scale.set(Math.max(rw * p, 1e-4), rowH * 0.94, 1);
      fill.position.set(-rw / 2 + (rw * p) / 2, rowTop(index) - rowH / 2, 0.003);
    },
    prewarm(on) {
      material.opacity = on ? 0 : 1;
      fillMaterial.opacity = on ? 0 : 0.42;
      mesh.visible = on;
      fill.visible = on;
    },
    hit(x, y) {
      if (Math.abs(x) > W / 2 - pad) return -1;
      for (let i = 0; i < items.length; i++) {
        const top = rowTop(i);
        if (y <= top && y >= top - rowH) return i;
      }
      return -1;
    },
    get width() {
      return W;
    },
    get height() {
      return height;
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
      fillGeometry.dispose();
      fillMaterial.dispose();
      texture.dispose();
    },
  };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
