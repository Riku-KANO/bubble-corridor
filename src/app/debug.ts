// ?debug の性能表示。fps、描画呼び出し、三角形の数、乗車の時刻と区間、描画解像度の倍率。
import type * as THREE from 'three/webgpu';

export interface DebugSample {
  readonly frameMs: number;
  readonly t: number;
  readonly section: string;
  readonly info: THREE.Renderer['info'];
  readonly screen: string;
  readonly scale: number;
}

export function createDebugOverlay(root: HTMLElement, backend: string) {
  const el = document.createElement('pre');
  el.className = 'debug-overlay';
  el.style.cssText =
    'position:fixed;top:8px;left:8px;margin:0;padding:6px 8px;background:rgba(0,0,0,.55);color:#cfe;font:12px/1.4 ui-monospace,monospace;z-index:100;pointer-events:none;white-space:pre';
  root.append(el);
  let acc = 0;
  let frames = 0;
  let fps = 0;
  // e2e と snap が読むための値（window.__utakata）
  const shared = { fps: 0, calls: 0, triangles: 0, t: 0, section: '', screen: '', backend };
  (globalThis as unknown as { __utakata?: typeof shared }).__utakata = shared;
  return {
    update(s: DebugSample) {
      acc += s.frameMs;
      frames++;
      if (acc >= 500) {
        fps = (frames * 1000) / acc;
        acc = 0;
        frames = 0;
      }
      const m = Math.floor(s.t / 60);
      const sec = (s.t % 60).toFixed(1).padStart(4, '0');
      const calls = s.info.render.drawCalls;
      const tris = s.info.render.triangles;
      Object.assign(shared, { fps, calls, triangles: tris, t: s.t, section: s.section, screen: s.screen });
      el.textContent = `${backend}  ${fps.toFixed(1)} fps  calls ${calls}  tris ${(tris / 1000).toFixed(0)}k  scale ${s.scale.toFixed(2)}\n${s.screen}  ${m}:${sec}  ${s.section}`;
    },
  };
}
