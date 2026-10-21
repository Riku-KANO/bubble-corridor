// S-24 TRN-2 VR の暗転: VR は後処理を使わないので、天球の頭の2秒の暗転と点灯を、頭に付けた暗い球で出す。
// ゴンドラの縁は動かない基準として見えたまま（設計書 147 行）。レビュー1巡目 P2-1 をテストにしたもの（親が作成。実装担当は変更しない）
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { CAMERA, GONDOLA_DIAMETER } from '../config';
import { createXRDarkness } from './xr-darkness';

const meshOf = (o: THREE.Object3D): THREE.Mesh => {
  let m: THREE.Mesh | null = null;
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh && !m) m = c as THREE.Mesh;
  });
  if (!m) throw new Error('メッシュがない');
  return m;
};

describe('TRN-2 VR の暗転', () => {
  it('明るさ 1 では描かない（描画の呼び出しを増やさない）', () => {
    const d = createXRDarkness();
    d.set(1);
    expect(d.object.visible).toBe(false);
  });

  it('明るさ 0 で完全な黒。途中は 1 − 明るさの濃さ。呼ぶ順に依らない', () => {
    const d = createXRDarkness();
    d.set(0);
    const mat = meshOf(d.object).material as THREE.MeshBasicMaterial;
    expect(d.object.visible).toBe(true);
    expect([mat.color.r, mat.color.g, mat.color.b]).toEqual([0, 0, 0]);
    expect(mat.opacity).toBeCloseTo(1, 6);
    d.set(0.25);
    expect(mat.opacity).toBeCloseTo(0.75, 6);
    d.set(0.9);
    d.set(0.25);
    expect(mat.opacity).toBeCloseTo(0.75, 6);
  });

  it('ゴンドラの外側（目から最も遠いゴンドラの点より外）に球があり、深さで手前の物（ゴンドラの縁）を隠さない', () => {
    const d = createXRDarkness();
    d.set(0);
    const mesh = meshOf(d.object);
    const g = mesh.geometry as THREE.BufferGeometry;
    g.computeBoundingSphere();
    const r = g.boundingSphere!.radius * mesh.scale.x;
    expect(r).toBeGreaterThan(GONDOLA_DIAMETER / 2 + CAMERA.seatEyeHeight + 0.05);
    expect(r).toBeLessThanOrEqual(5);
    const mat = mesh.material as THREE.Material;
    expect(mat.depthTest).toBe(true);
    expect(mat.side === THREE.BackSide || mat.side === THREE.DoubleSide).toBe(true);
  });

  it('dispose で形と材質を解放する', () => {
    const d = createXRDarkness();
    const mesh = meshOf(d.object);
    let geo = false;
    let mat = false;
    mesh.geometry.addEventListener('dispose', () => (geo = true));
    (mesh.material as THREE.Material).addEventListener('dispose', () => (mat = true));
    d.dispose();
    expect(geo && mat).toBe(true);
  });
});
