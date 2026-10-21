// S-20 ゴンドラ（泡）（親が作成。実装担当は変更しない）
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { CAMERA, GONDOLA_DIAMETER } from '../config';
import { drawStats, findByRole } from '../rooms/testing';
import { createGondola } from './index';

describe('ゴンドラ（泡）', () => {
  it('直径約2.4mの泡の殻と、目の高さの座席', () => {
    const g = createGondola();
    g.root.updateMatrixWorld(true);
    expect(g.seat.position.y).toBeCloseTo(CAMERA.seatEyeHeight, 6);
    const shell = findByRole(g.root, 'shell')[0];
    expect(shell).toBeDefined();
    const size = new THREE.Box3().setFromObject(shell).getSize(new THREE.Vector3());
    expect(Math.abs(size.x - GONDOLA_DIAMETER) / GONDOLA_DIAMETER).toBeLessThan(0.05);
  });

  it('視界の下側に常に縁（真鍮の枠と手すり）が見える: 目より下、正面下 35° 以内', () => {
    const g = createGondola();
    g.root.updateMatrixWorld(true);
    const rims = findByRole(g.root, 'rim');
    expect(rims.length).toBeGreaterThan(0);
    const box = new THREE.Box3();
    for (const r of rims) box.union(new THREE.Box3().setFromObject(r));
    const eyeY = g.seat.getWorldPosition(new THREE.Vector3()).y;
    expect(box.max.y).toBeLessThan(eyeY - 0.15);
    // 正面（-Z）の縁の上端までの見下ろす角度
    const front = Math.abs(box.min.z);
    const angle = Math.atan2(eyeY - box.max.y, front) * (180 / Math.PI);
    expect(angle).toBeLessThanOrEqual(35);
    expect(box.max.x - box.min.x).toBeGreaterThan(1.6);
  });

  it('殻の閉じ具合を変えられる（例外なし、閉じれば見える）', () => {
    const g = createGondola();
    expect(() => {
      g.setShell(0);
      g.setShell(0.5);
      g.setShell(1);
      g.update(1, 1 / 60);
    }).not.toThrow();
    expect(findByRole(g.root, 'shell')[0].visible).toBe(true);
  });

  it('REN-3 最も長く映るが、三角形は15万以下', () => {
    expect(drawStats(createGondola().root).triangles).toBeLessThanOrEqual(150_000);
  });

  it('REN-3 乗車中ずっと毎フレーム描くので、描く物は 10 以下（動かない真鍮は色ごとにまとめる。VR では目ごとに倍。レビュー1巡目 P2-3）', () => {
    expect(drawStats(createGondola().root).drawables).toBeLessThanOrEqual(10);
  });

  it('dispose で形を解放する', () => {
    const g = createGondola();
    const geos: THREE.BufferGeometry[] = [];
    g.root.traverse((o) => {
      const geo = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (geo && !geos.includes(geo)) geos.push(geo);
    });
    const disposed = new Set<THREE.BufferGeometry>();
    for (const geo of geos) geo.addEventListener('dispose', () => disposed.add(geo));
    g.dispose();
    expect(disposed.size).toBe(geos.length);
  });
});
