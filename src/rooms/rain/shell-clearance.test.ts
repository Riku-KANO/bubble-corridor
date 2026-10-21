// RIDE-8 の補い（rooms-b の実装担当のテスト）。部屋のテストは物を軸に沿った箱で測るので、レールを囲む連続した形
// （回廊の壁・腰壁・突き当たりの壁・万華鏡の鏡の板と輪）は箱では測れず clearanceExempt にしてある。
// ここではその殻を本当の三角形で測り、ゴンドラの表面から 0.5m 以上（レールの中心から 1.7m 以上）あることを確かめる。
// レールは区間の前後 MARGIN m まで（隣の区間から見える所、部屋の境目の物も。ADR-0013）。exempt のインスタンス描画も
// インスタンスごとに測る（黙って外さない）。外すのは通り抜ける物（膜・光・水の膜の重ね、userData.passThrough）だけ。
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { GONDOLA_DIAMETER, MOTION } from '../../config';
import type { SectionId } from '../../contracts/ids';
import type { RoomFactory } from '../../contracts/room';
import { createKaleidoscopeRoom } from '../kaleidoscope';
import { loadRoom, ride } from '../testing';
import { createRainRoom } from './index';

const NEED = GONDOLA_DIAMETER / 2 + MOTION.clearanceMin;
const MARGIN = 3;
/** 光（輪・にじみ）と通り抜ける膜は物ではない */
const NOT_MATTER = new Set(['membrane', 'light', 'film']);

function passes(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.passThrough || NOT_MATTER.has(String(p.userData.role))) return true;
  return false;
}

async function shellViolations(factory: RoomFactory, section: SectionId) {
  const { room } = await loadRoom(factory);
  room.root.updateMatrixWorld(true);
  const tris: { tri: THREE.Triangle; c: THREE.Vector3; r: number; name: string }[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let shells = 0;
  const m = new THREE.Matrix4();
  room.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    let exempt = false;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.clearanceExempt) exempt = true;
    if (!mesh.isMesh || !exempt || passes(o)) return;
    shells++;
    const g = mesh.geometry as THREE.BufferGeometry;
    const pos = g.attributes.position;
    const idx = g.index;
    const n = idx ? idx.count : pos.count;
    const im = o as THREE.InstancedMesh;
    const count = im.isInstancedMesh ? im.count : 1;
    for (let k = 0; k < count; k++) {
      if (im.isInstancedMesh) {
        im.getMatrixAt(k, m);
        m.premultiply(mesh.matrixWorld);
      } else m.copy(mesh.matrixWorld);
      for (let i = 0; i < n; i += 3) {
        const i0 = idx ? idx.getX(i) : i;
        const i1 = idx ? idx.getX(i + 1) : i + 1;
        const i2 = idx ? idx.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(m);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m);
        const tri = new THREE.Triangle(a.clone(), b.clone(), c.clone());
        const center = a.clone().add(b).add(c).divideScalar(3);
        const r = Math.max(center.distanceTo(a), center.distanceTo(b), center.distanceTo(c));
        tris.push({ tri, c: center, r, name: String(o.userData.name ?? o.name) });
      }
    }
  });
  const { s0, s1 } = ride.sectionSpan(section);
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  const bad: [string, number, number][] = [];
  for (let s = Math.max(0, s0 - MARGIN); s <= s1 + MARGIN; s += 0.5) {
    const pt = ride.pointAt(s);
    p.set(pt.x, pt.y, pt.z);
    for (const t of tris) {
      if (t.c.distanceTo(p) - t.r >= NEED) continue;
      t.tri.closestPointToPoint(p, q);
      const d = q.distanceTo(p);
      if (d < NEED) bad.push([t.name, Math.round(s * 10) / 10, Math.round(d * 1000) / 1000]);
    }
  }
  room.dispose();
  return { shells, triangles: tris.length, bad };
}

describe('RIDE-8 殻（clearanceExempt の連続した形）も本当の形で 1.7m 以上', () => {
  it('雨の回廊', async () => {
    const r = await shellViolations(createRainRoom, 'rain');
    expect(r.shells).toBeGreaterThan(3);
    expect(r.bad.slice(0, 5)).toEqual([]);
  });
  it('万華鏡の間', async () => {
    const r = await shellViolations(createKaleidoscopeRoom, 'kaleidoscope');
    expect(r.shells).toBeGreaterThan(3);
    expect(r.bad.slice(0, 5)).toEqual([]);
  });
});
